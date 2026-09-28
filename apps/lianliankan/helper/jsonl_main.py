"""JSON Lines helper for the Mini App Host.

对宿主的协议:stdin 每行一个 JSON 请求,stdout 每行一个 JSON 应答。
视觉/求解代码(vision/ solver/)从原项目原样迁移,本文件只做协议包装;
截图由 Host 完成(host.screen),点击由 Host 执行(host.mouse),
本进程只处理图像 → 棋盘状态 → 着法。

Ops:
  configure      {rows, cols, thresholds{...}}         -> 会话重建(清空背景学习)
  scan           {image_b64, origin_x, origin_y}       -> 棋盘识别(存会话,供 solve-board 用)
  solve-board    {}                                    -> 离线解出当前盘面的完整连消计划
  verify         {tiles:[{row, col, image_b64}, ...]}  -> 逐格判空;全空则学习背景
  learn-background {image_b64}                         -> 从整盘学习空格背景
  detect-grid    {image_b64}                           -> 自动推断行列数
  reset          {}                                    -> 清空失败对 + 背景学习
  selftest       {}                                    -> 合成图全链路自检
"""
from __future__ import annotations

import base64
import json
import sys
import time

import cv2
import numpy as np

from src.solver.board import Board
from src.solver.move_finder import find_all_moves, find_move
from src.vision.board_builder import BoardBuilder
from src.vision.empty_detector import EmptyDetector
from src.vision.grid import TileExtractor
from src.vision.grid_detector import GridDetector
from src.vision.prob_classifier import ProbClassifier


class Session:
    """有状态会话:阈值 + 空格背景学习 + 验证失败排除表。"""

    def __init__(self, params: dict):
        self.rows = int(params.get("rows", 10))
        self.cols = int(params.get("cols", 14))
        t = params.get("thresholds") or {}
        self.extractor = TileExtractor(float(t.get("tile_inner_ratio", 0.8)))
        self.empty_detector = EmptyDetector(
            var_threshold=float(t.get("empty_var_threshold", 12.0)),
            edge_threshold=float(t.get("empty_edge_threshold", 0.02)),
            bg_diff_threshold=float(t.get("empty_bg_diff_threshold", 10.0)),
        )
        # 概率模型参考中心 μ0(用户可调;EM 围绕它收敛)
        self.clf = ProbClassifier(float(t.get("similarity_threshold", 0.75)))
        self.builder = BoardBuilder()
        self._failed_pairs: set = set()
        self._last_board: Board | None = None
        self._last_tiles: list = []

    # -- ops ---------------------------------------------------------------
    def scan(self, params: dict) -> dict:
        image = decode_image(params["image_b64"])
        origin_x = int(params.get("origin_x", 0))
        origin_y = int(params.get("origin_y", 0))
        start = time.perf_counter()

        tiles = self.extractor.extract(
            image, self.rows, self.cols, origin_x=origin_x, origin_y=origin_y
        )
        # 判空双图:内缩裁剪管方差/边缘统计,整格管帧环否决(图块描边框
        # 在内缩裁不到的外圈,见 EmptyDetector.is_empty)
        cell_h = image.shape[0] / self.rows
        cell_w = image.shape[1] / self.cols
        for tile in tiles:
            fx0, fy0 = int(round(tile.col * cell_w)), int(round(tile.row * cell_h))
            fx1, fy1 = int(round((tile.col + 1) * cell_w)), int(round((tile.row + 1) * cell_h))
            full_cell = image[fy0:fy1, fx0:fx1]
            tile.empty = self.empty_detector.is_empty(
                tile.image, row=tile.row, col=tile.col,
                rows=self.rows, cols=self.cols,
                full_image=full_cell,
            )
            # 统计像空、帧环说不是 → 图块但特征不可信(选中态残留等),
            # 规划时禁配对(游戏里选中中的图块本来也点不成对)
            if not tile.empty and self.empty_detector.frame_veto(tile.image, full_cell):
                tile.suspect = True
        self.clf.classify(tiles, ref=self.clf.ref)
        board = self.builder.build(tiles)
        self._last_board = board
        self._last_tiles = tiles
        elapsed_ms = (time.perf_counter() - start) * 1000.0

        move = None
        if not board.is_cleared():
            raw = self._pick_move(board, self._failed_pairs)
            if raw is not None:
                move = {"a": self._tile_for(tiles, raw.a), "b": self._tile_for(tiles, raw.b)}

        return {
            "board": board.logical_grid,
            "cleared": board.is_cleared(),
            "tiles_left": board.tiles_left(),
            "tiles": [
                {
                    "row": t.row, "col": t.col,
                    "x": t.x, "y": t.y, "width": t.width, "height": t.height,
                    "center_x": t.center_x, "center_y": t.center_y,
                    "empty": t.empty, "type_id": t.type_id, "suspect": t.suspect,
                }
                for t in tiles
            ],
            "recognized": sum(1 for t in tiles if not t.empty),
            "tile_types": len({t.type_id for t in tiles if not t.empty}),
            "suspect_count": sum(1 for t in tiles if t.suspect),
            "threshold_used": round(float(getattr(self.clf, "mu", 0.0)), 3),
            "empty_count": sum(1 for t in tiles if t.empty),
            "elapsed_ms": round(elapsed_ms, 1),
            "move": move,
        }

    def solve_board(self, params: dict) -> dict:
        """离线解出上次 scan 盘面的完整连消计划(不出声、不点击)。

        连连看的消除是确定性的:识别一次即可在虚拟盘上推演后续所有
        着法,执行阶段按序点击 + 逐对验证即可;验证失败(或有人手动
        动过盘面)由上层重扫重规划。贪心可能因顺序问题提前死局,此时
        尝试换前几个"第一步"重算,取最长计划;仍死局则上层执行完已得
        计划后重扫续解。"""
        if self._last_board is None:
            raise ValueError("solve-board 之前先 scan")

        moves = []
        probe = Board(self._last_board.grid)
        while not probe.is_cleared():
            mv = self._pick_move(probe, self._failed_pairs)
            if mv is None:
                break
            moves.append(mv)
            probe.remove_move(mv)
        if not probe.is_cleared():  # 贪心死局 → 换第一步再试,取最长计划
            tried = 0
            suspects = {(t.row + 1, t.col + 1) for t in self._last_tiles if t.suspect}
            for first in find_all_moves(Board(self._last_board.grid)):
                if frozenset((first.a, first.b)) in self._failed_pairs:
                    continue
                if first.a in suspects or first.b in suspects:
                    continue
                tried += 1
                if tried > 6:
                    break
                work = Board(self._last_board.grid)
                work.remove_move(first)
                seq = [first] + self._greedy(work)
                if len(seq) > len(moves):
                    moves = seq
                    if work.is_cleared():
                        break

        cleared = Board(self._last_board.grid)
        for mv in moves:
            cleared.remove_move(mv)
        return {
            "status": "CLEARED" if cleared.is_cleared() else "DEADLOCK",
            "moves": [
                {
                    "a": self._tile_for(self._last_tiles, mv.a),
                    "b": self._tile_for(self._last_tiles, mv.b),
                    "confidence": round(float(min(
                        getattr(self._last_tile_at(mv.a), "confidence", 0.0) or 0.0,
                        getattr(self._last_tile_at(mv.b), "confidence", 0.0) or 0.0,
                    )), 3),
                }
                for mv in moves
            ],
            "remaining": cleared.tiles_left(),
            "threshold_used": round(float(getattr(self.clf, "mu", 0.0)), 3),
        }

    def verify(self, params: dict) -> dict:
        entries = params.get("tiles") or []
        if not entries:
            raise ValueError("verify: tiles 为空")
        empties = []
        for entry in entries:
            image = decode_image(entry["image_b64"])
            empties.append(
                self.empty_detector.is_empty(
                    image, row=int(entry["row"]), col=int(entry["col"])
                )
            )
        all_empty = all(empties)
        if all_empty:
            for entry in entries:
                image = decode_image(entry["image_b64"])
                self.empty_detector.learn_background(
                    image, int(entry["row"]), int(entry["col"])
                )
            self._failed_pairs.clear()
        return {"empties": empties, "learned": all_empty}

    def learn_background(self, params: dict) -> dict:
        image = decode_image(params["image_b64"])
        learned = self.empty_detector.set_background(image, self.rows, self.cols)
        return {"learned": learned}

    def detect_grid(self, params: dict) -> dict:
        image = decode_image(params["image_b64"])
        detection = GridDetector().detect(image)
        if detection is None:
            return {"found": False}
        return {
            "found": True,
            "rows": detection.rows,
            "cols": detection.cols,
            "error": round(detection.error, 4),
        }

    def exclude_pair(self, params: dict) -> dict:
        """验证失败的一对加入排除表(逻辑坐标;find_move 用加圈坐标比较)。

        不加这条,重扫规划会把同一对失败着法原样再点一遍。"""
        def padded(pos: dict) -> tuple:
            return (int(pos.get("row", -2)) + 1, int(pos.get("col", -2)) + 1)

        a, b = params.get("a") or {}, params.get("b") or {}
        self._failed_pairs.add(frozenset((padded(a), padded(b))))
        return {"excluded": len(self._failed_pairs)}

    def reset(self) -> dict:
        self._failed_pairs.clear()
        self.empty_detector.clear_background()
        return {"reset": True}

    # -- helpers -------------------------------------------------------------
    def _greedy(self, board: Board) -> list:
        seq = []
        while not board.is_cleared():
            mv = self._pick_move(board, self._failed_pairs)
            if mv is None:
                break
            seq.append(mv)
            board.remove_move(mv)
        return seq

    def _pick_move(self, board: Board, exclude: set | None = None):
        """首个可用着法:跳过排除对与嫌疑块(选中态/坏特征,点了也成不了对)。

        正常情况 find_move 一次命中,只有首着法撞上嫌疑块才全量枚举。"""
        mv = find_move(board, exclude=exclude)
        suspects = {(t.row + 1, t.col + 1) for t in self._last_tiles if t.suspect}
        if mv is None or not suspects or (mv.a not in suspects and mv.b not in suspects):
            return mv
        for m in find_all_moves(board):
            if exclude and frozenset((m.a, m.b)) in exclude:
                continue
            if m.a in suspects or m.b in suspects:
                continue
            return m
        return None

    def _last_tile_at(self, padded_pos):
        row, col = padded_pos[0] - 1, padded_pos[1] - 1
        return next((t for t in self._last_tiles if t.row == row and t.col == col), None)

    @staticmethod
    def _tile_for(tiles, padded_pos) -> dict:
        """move 坐标带外圈(+1);换算回逻辑格并取 tile 的屏幕坐标。"""
        row, col = padded_pos[0] - 1, padded_pos[1] - 1
        for t in tiles:
            if t.row == row and t.col == col:
                return {
                    "row": t.row, "col": t.col,
                    "center_x": t.center_x, "center_y": t.center_y,
                }
        raise ValueError(f"move 指向不存在的 tile: ({row},{col})")


SESSION = Session({})


def decode_image(image_b64: str) -> np.ndarray:
    buf = base64.b64decode(image_b64)
    image = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("图像解码失败")
    return image


# -- selftest: 合成图全链路(无游戏、无截图) ---------------------------------

def _synthetic_board(cells: dict[tuple[int, int], tuple[int, int, int]]) -> np.ndarray:
    """4x4 棋盘,cells 指定 (row,col)->BGR 颜色,其余为白底(空格)。"""
    image = np.full((400, 400, 3), 255, dtype=np.uint8)
    for (row, col), color in cells.items():
        x0, y0 = col * 100 + 10, row * 100 + 10
        cv2.rectangle(image, (x0, y0), (x0 + 80, y0 + 80), color, -1)
        cv2.rectangle(image, (x0, y0), (x0 + 80, y0 + 80), (60, 60, 60), 2)
    return image


def selftest() -> dict:
    colors = {
        (0, 0): (80, 60, 220), (3, 3): (80, 60, 220),   # pair 1
        (0, 3): (60, 180, 60), (3, 0): (60, 180, 60),   # pair 2
        (1, 1): (200, 120, 30), (2, 2): (200, 120, 30),  # pair 3
    }
    session = Session({
        "rows": 4,
        "cols": 4,
        "thresholds": {
            "tile_inner_ratio": 0.8,
            "empty_var_threshold": 12.0,
            "empty_edge_threshold": 0.02,
            "empty_bg_diff_threshold": 10.0,
            "similarity_threshold": 0.8,
        },
    })
    board_png = encode_b64(_synthetic_board(colors))
    scan = session.scan({"image_b64": board_png, "origin_x": 0, "origin_y": 0})
    empty_a = encode_b64(np.full((80, 80, 3), 255, dtype=np.uint8))
    empty_b = encode_b64(np.full((80, 80, 3), 250, dtype=np.uint8))
    verify = session.verify({
        "tiles": [
            {"row": 0, "col": 1, "image_b64": empty_a},
            {"row": 1, "col": 0, "image_b64": empty_b},
        ]
    })
    return {
        "recognized": scan["recognized"],
        "tile_types": scan["tile_types"],
        "empty_count": scan["empty_count"],
        "move_found": scan["move"] is not None,
        "verify_empty": verify["empties"],
        "ok": scan["recognized"] == 6
        and scan["tile_types"] == 3
        and scan["move"] is not None
        and all(verify["empties"]),
    }


def encode_b64(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("PNG 编码失败")
    return base64.b64encode(buf.tobytes()).decode("ascii")


# -- main loop ---------------------------------------------------------------

OPS_NEEDING_SESSION = {"scan", "verify", "learn-background", "detect-grid", "solve-board", "exclude-pair"}


def handle(request: dict) -> dict:
    op = request.get("op")
    if op == "configure":
        global SESSION
        SESSION = Session(request)
        return {"configured": True, "rows": SESSION.rows, "cols": SESSION.cols}
    if op == "reset":
        return SESSION.reset()
    if op == "selftest":
        return selftest()
    if op in OPS_NEEDING_SESSION:
        return getattr(SESSION, op.replace("-", "_"))(request)
    raise ValueError(f"unknown op: {op}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            result = handle(request)
            response = {"ok": True, "id": request.get("id"), **result}
        except Exception as err:  # never crash the loop on one bad request
            response = {
                "ok": False,
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": f"{type(err).__name__}: {err}",
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

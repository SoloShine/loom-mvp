"""Empty tile detection (PRD section 3).

判定顺序:
1. 保守启发式 (低方差 AND 低边缘密度) —— 两者同时满足才可能是空格
2. 已学习的逐格背景: 该位置曾经确认为空格, 与记录比对一致则为空格
   (背景参考只学习确实为空的格子, 不会像整盘快照那样被图块污染)

扫描与点击后验证必须走同一条路径, 否则会出现「扫描说是图块、验证说是
空格」的不一致。
"""
from __future__ import annotations

import cv2
import numpy as np


class EmptyDetector:
    def __init__(
        self,
        var_threshold: float = 12.0,
        edge_threshold: float = 0.02,
        bg_diff_threshold: float = 10.0,
    ):
        self.var_threshold = var_threshold
        self.edge_threshold = edge_threshold
        self.bg_diff_threshold = bg_diff_threshold
        # (row, col) -> 该位置确认为空格时的 64x64 灰度图
        self._bg_cells: dict[tuple[int, int], np.ndarray] = {}

    # -- 背景学习 ----------------------------------------------------------
    def set_background(self, board_image: np.ndarray, rows: int, cols: int) -> int:
        """从整盘截图中学习背景: 只保留当前启发式判定为空的格子。

        返回学习的格子数。已有学习结果会被整体替换。
        """
        self._bg_cells.clear()
        bg_h, bg_w = board_image.shape[:2]
        cell_w, cell_h = bg_w // cols, bg_h // rows
        if cell_w == 0 or cell_h == 0:
            return 0
        learned = 0
        for r in range(rows):
            for c in range(cols):
                cell = board_image[r * cell_h:(r + 1) * cell_h,
                                   c * cell_w:(c + 1) * cell_w]
                if cell.size and self._looks_empty(cell):
                    self.learn_background(cell, r, c)
                    learned += 1
        return learned

    def learn_background(self, tile_image: np.ndarray, row: int, col: int) -> None:
        """记录某个位置确认为空格时的外观 (如消除成功后的截图)。"""
        self._bg_cells[(row, col)] = self._normalize(tile_image)

    def has_background(self, row: int | None = None, col: int | None = None) -> bool:
        if row is None or col is None:
            return bool(self._bg_cells)
        return (row, col) in self._bg_cells

    def clear_background(self) -> None:
        self._bg_cells.clear()

    # -- 主接口 -------------------------------------------------------------
    def is_empty(self, tile_image: np.ndarray, row: int | None = None,
                 col: int | None = None, rows: int | None = None,
                 cols: int | None = None,
                 full_image: np.ndarray | None = None) -> bool:
        if tile_image.size == 0:
            return True
        # 1) 保守启发式: 方差低 AND 边缘少 (OR 会把平坦浅色图块误判为空)
        if self._looks_empty(tile_image):
            # 帧环否决:深色图块叠深色关卡背景时方差/边缘双双走低,会被
            # 误判成空格 —— 规划器借"幽灵空格"连出游戏不认的着法,点击
            # 后盘面纹丝不动(实测卡局)。图块的亮色描边框是最后一道闸;
            # 统计只能用内缩裁剪(整格边缘混入邻块描边会污染方差/边缘),
            # 描边框本身只存在于内缩裁不到的外圈,所以要另传整格图。
            if full_image is None or not self._has_frame(full_image):
                return True
            return False
        # 2) 该位置学过背景: 以比对结果为准 (图块外观不会和空格一致)
        if (row, col) in self._bg_cells:
            return self._matches_background(tile_image, row, col)
        return False

    # -- 启发式 --------------------------------------------------------------
    def _looks_empty(self, tile_image: np.ndarray) -> bool:
        gray = cv2.cvtColor(tile_image, cv2.COLOR_BGR2GRAY)
        low_var = float(gray.std()) < self.var_threshold
        edges = cv2.Canny(gray, 50, 150)
        density = float(np.count_nonzero(edges)) / edges.size
        return low_var and density < self.edge_threshold

    def frame_veto(self, tile_image: np.ndarray, full_image: np.ndarray) -> bool:
        """统计上像空格、但整格外圈找得到描边框 —— 是图块,且内芯特征
        不可信(典型:验证失败后游戏里残留的选中态图块,内芯被选中渲染
        压暗)。调用方应把它当图块并禁止配对,见 Tile.suspect。"""
        return self._looks_empty(tile_image) and self._has_frame(full_image)

    @staticmethod
    def _has_frame(full_cell: np.ndarray) -> bool:
        """整格外圈是否找得到图块描边框:明显亮于格子主体的像素在
        ≥3 条边的外圈条带里连成片。真空格的暗底/浅底都找不到。"""
        gray = cv2.cvtColor(full_cell, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        median = float(np.median(gray))
        bright = gray > max(median + 25.0, 90.0)
        if float(bright.mean()) < 0.04:
            return False
        band = max(2, min(h, w) // 8)
        sides = 0
        for strip in (bright[:band, :], bright[h - band:, :],
                      bright[:, :band], bright[:, w - band:]):
            if float(strip.mean()) > 0.25:
                sides += 1
        return sides >= 3

    # -- 背景比对 --------------------------------------------------------------
    def _matches_background(self, tile_image: np.ndarray, row: int, col: int) -> bool:
        reference = self._bg_cells[(row, col)]
        diff = float(np.mean(np.abs(
            self._normalize(tile_image).astype(np.float32) - reference.astype(np.float32)
        )))
        return diff < self.bg_diff_threshold

    @staticmethod
    def _normalize(image: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)

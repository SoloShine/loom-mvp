"""Automatic grid detection: infer rows/cols from the board image (PRD 2.B
的后续扩展).

Method: 长直线提取 + 边界峰拟合.
1. Canny 边缘; 用长度约棋盘短边 1/12 的水平/垂直结构元素做开运算,
   只保留贯穿多个图块的格框长直线 (图标内部的短边缘被滤除)
2. 对长直线做投影, 找边界峰; 相邻 5px 内的峰合并 (双线)
3. 格距 = 边界间距的中位数 (剔除漏检产生的倍距)
4. rows/cols = 边界跨度 / 格距; 若跨度末端还剩 ≥半格距的条带且条带里
   确有图块内容 (边缘投影强度与盘内相当), 补 1 行/列 —— 贴边截图时
   最外侧边框线落在图像边缘, Canny 响应被削弱, 常被峰地板误杀漏检,
   不补就会少算一整行/列 (10 行判成 9 行的实锤案例)

开局满盘时格框线最完整, 检测最可靠。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

_MIN_CELLS = 3
_MAX_CELLS = 30
_MIN_PITCH = 15  # px
_MAX_Q = 0.3  # 边界峰相位残差上限 (相对半格距)


@dataclass
class GridDetection:
    rows: int
    cols: int
    pitch_x: float
    pitch_y: float
    error: float  # 边界间距的离散度 (std/median), 越小越规整
    tiles_seen: int  # 边界长直线数量 (两轴合计)


class GridDetector:
    def detect(self, image: np.ndarray) -> GridDetection | None:
        if image is None or image.size == 0:
            return None
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        img_h, img_w = gray.shape
        edges = cv2.Canny(gray, 60, 150)

        line_len = max(min(img_h, img_w) // 12, 12)
        # 相邻图块各自的边框会在缝隙两侧形成 ~4-8px 的双线, 先沿垂直于
        # 线的方向闭运算融合成一条, 否则边界峰成对出现破坏格距统计
        gap = max(3, min(img_h, img_w) // 60)
        vert = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((1, gap), np.uint8))
        vert = cv2.morphologyEx(vert, cv2.MORPH_OPEN, np.ones((line_len, 1), np.uint8))
        horiz = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((gap, 1), np.uint8))
        horiz = cv2.morphologyEx(horiz, cv2.MORPH_OPEN, np.ones((1, line_len), np.uint8))
        if np.count_nonzero(vert) < 50 or np.count_nonzero(horiz) < 50:
            return None

        px = self._boundary_positions(vert.sum(axis=0).astype(float), line_len)
        py = self._boundary_positions(horiz.sum(axis=1).astype(float), line_len)
        if px is None or py is None:
            return None
        merged_x, pitch_x, ex, prof_x = px
        merged_y, pitch_y, ey, prof_y = py

        # 用边界跨度计数 (最外侧边界即棋盘边缘, 对框选误差不敏感);
        # 末端残余条带检测见模块 docstring 第 4 点
        cols = self._cell_count(merged_x, pitch_x, img_w, prof_x)
        rows = self._cell_count(merged_y, pitch_y, img_h, prof_y)
        if not (_MIN_CELLS <= cols <= _MAX_CELLS and _MIN_CELLS <= rows <= _MAX_CELLS):
            return None
        return GridDetection(
            rows=rows, cols=cols, pitch_x=pitch_x, pitch_y=pitch_y,
            error=max(ex, ey), tiles_seen=len(merged_x) + len(merged_y),
        )

    # -- 边界峰 -> 格距 ------------------------------------------------------
    def _boundary_positions(self, profile: np.ndarray, line_len: int):
        """对边界峰位置做格距相位拟合。

        注意图块自身的高/宽 (intra-tile) 与格距 (inter-cell) 都会产生
        间距峰, 但只有真实格距能让所有峰落在同一相位网格上
        (x mod p ≈ 0 或 p), 据此区分。
        """
        positions = np.array(self._peaks(profile, line_len), dtype=np.float64)
        if len(positions) < 4:
            return None
        n = len(profile)
        best_p, best_q = None, 1e9
        for p in range(_MIN_PITCH, n // 2):
            m = positions % p
            d = np.minimum(m, p - m)
            q = float(d.mean()) / (p / 2.0)
            if q < best_q:
                best_q, best_p = q, p
        if best_p is None or best_q > _MAX_Q:
            return None
        smoothed = np.convolve(profile, np.ones(3) / 3, mode="same")
        return positions, best_p, best_q, smoothed

    def _cell_count(self, positions: np.ndarray, pitch: float,
                    extent: int, prof: np.ndarray) -> int:
        """边界跨度定行/列数; 两侧残余条带有内容则补 1。"""
        n = int(round((positions[-1] - positions[0]) / pitch))
        interior = prof[int(positions[0]):int(positions[-1]) + 1]
        ref = float(interior.mean()) or 1.0
        for lo, hi in ((0.0, positions[0]), (positions[-1] + 1.0, float(extent))):
            if hi - lo < 0.5 * pitch:
                continue
            strip = prof[int(lo):int(hi)]
            if float(strip.mean()) >= 0.2 * ref:
                n += 1
        return n

    @staticmethod
    def _peaks(profile: np.ndarray, line_len: int) -> list[int]:
        prof = np.convolve(profile, np.ones(3) / 3, mode="same")
        # 峰地板 = 绝对线强度与相对强度取小。某一行图块内容巧合对齐时
        # max 会被撑大十几倍, 相对地板(0.08*max)随之抬高, 会把贴边截图
        # 时本就微弱的最外侧边框线误杀 -> 整行/列漏数。绝对地板取
        # "半条 1px 长线"的平滑后强度(整线 ≈ line_len*255, 平滑摊到 3 行)。
        absolute = 0.5 * line_len * 255.0 / 3.0
        floor = max(float(np.percentile(prof, 60)),
                    min(0.08 * float(prof.max()), absolute))
        # 补零后全范围扫描, 否则贴着图像边缘的边界峰会被排除
        padded = np.concatenate(([0.0], prof, [0.0]))
        return [
            x for x in range(len(prof))
            if padded[x + 1] >= padded[x:x + 3].max() and padded[x + 1] > floor
        ]

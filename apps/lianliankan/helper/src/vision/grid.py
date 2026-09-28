"""Grid extraction: split the board screenshot into per-tile images (PRD 2.C)."""
from __future__ import annotations

import numpy as np

from .tile import Tile

DEFAULT_INNER_RATIO = 0.8


class TileExtractor:
    def __init__(self, inner_ratio: float = DEFAULT_INNER_RATIO):
        if not 0.0 < inner_ratio <= 1.0:
            raise ValueError("inner_ratio must be in (0, 1]")
        self.inner_ratio = inner_ratio

    def extract(self, board_image: np.ndarray, rows: int, cols: int,
                origin_x: int = 0, origin_y: int = 0) -> list[Tile]:
        """Crop every cell of the board image into a Tile.

        `origin_x/origin_y` are the screen coordinates of the board image's
        top-left corner, so tile positions become screen coordinates.
        """
        if board_image.ndim < 2:
            raise ValueError("board_image must be a HxW(xC) array")
        height, width = board_image.shape[:2]
        tile_w = width / cols
        tile_h = height / rows

        inset_x = tile_w * (1.0 - self.inner_ratio) / 2.0
        inset_y = tile_h * (1.0 - self.inner_ratio) / 2.0

        tiles: list[Tile] = []
        for r in range(rows):
            for c in range(cols):
                # inner crop, rounded inward to avoid bleeding into neighbours
                x0 = int(round(c * tile_w + inset_x))
                y0 = int(round(r * tile_h + inset_y))
                x1 = int(round((c + 1) * tile_w - inset_x))
                y1 = int(round((r + 1) * tile_h - inset_y))
                x0, x1 = max(x0, 0), min(x1, width)
                y0, y1 = max(y0, 0), min(y1, height)
                image = board_image[y0:y1, x0:x1].copy()

                screen_x = origin_x + x0
                screen_y = origin_y + y0
                tiles.append(
                    Tile(
                        row=r,
                        col=c,
                        x=screen_x,
                        y=screen_y,
                        width=x1 - x0,
                        height=y1 - y0,
                        center_x=origin_x + int(round((c + 0.5) * tile_w)),
                        center_y=origin_y + int(round((r + 0.5) * tile_h)),
                        image=image,
                    )
                )
        return tiles

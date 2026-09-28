"""Tile data model (PRD section 15)."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Tile:
    row: int  # logical row on the board (0-based)
    col: int  # logical column on the board (0-based)

    x: int  # screen x of the (inner) tile crop
    y: int  # screen y of the (inner) tile crop
    width: int
    height: int

    center_x: int  # screen center, used for clicking
    center_y: int

    image: np.ndarray  # BGR image of the inner tile area

    empty: bool = False
    # 统计上像空格但整格外圈有描边框(典型:验证失败后游戏里残留的
    # 选中态图块,内芯被选中渲染压暗)—— 是图块但特征不可信,不许配对
    suspect: bool = False
    type_id: int | None = None
    confidence: float | None = None
    feature: tuple | None = field(default=None, repr=False, compare=False)

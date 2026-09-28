"""Board data structure for lianliankan.

The board is stored with an empty border ring around the logical grid so that
paths may travel around the outside of the board, as in standard lianliankan
rules.

Grid values: 0 = empty, >0 = tile type id.
All coordinates used by the solver are *padded* coordinates, i.e. the logical
cell (0, 0) lives at padded (1, 1).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Move:
    """A pair of same-type tiles (padded coordinates) that can be linked."""

    a: tuple[int, int]
    b: tuple[int, int]
    path: tuple[tuple[int, int], ...] = ()


class Board:
    def __init__(self, grid: list[list[int]]):
        """`grid` must already be padded (border of zeros)."""
        if not grid or not grid[0]:
            raise ValueError("grid must be a non-empty 2D array")
        width = len(grid[0])
        if any(len(row) != width for row in grid):
            raise ValueError("grid rows must all have the same length")
        self.grid = [list(row) for row in grid]

    # -- construction ---------------------------------------------------
    @classmethod
    def from_logical(cls, logical: list[list[int]]) -> "Board":
        """Wrap a plain (unpadded) board with the empty border ring."""
        rows = len(logical)
        cols = len(logical[0]) if rows else 0
        padded = [[0] * (cols + 2) for _ in range(rows + 2)]
        for r in range(rows):
            for c in range(cols):
                padded[r + 1][c + 1] = logical[r][c]
        return cls(padded)

    # -- basic access ----------------------------------------------------
    @property
    def rows(self) -> int:
        return len(self.grid)

    @property
    def cols(self) -> int:
        return len(self.grid[0])

    def in_bounds(self, pos: tuple[int, int]) -> bool:
        r, c = pos
        return 0 <= r < self.rows and 0 <= c < self.cols

    def get(self, pos: tuple[int, int]) -> int:
        return self.grid[pos[0]][pos[1]]

    def set(self, pos: tuple[int, int], value: int) -> None:
        self.grid[pos[0]][pos[1]] = value

    def remove(self, pos: tuple[int, int]) -> None:
        self.set(pos, 0)

    def remove_move(self, move: Move) -> None:
        self.remove(move.a)
        self.remove(move.b)

    # -- derived state ---------------------------------------------------
    @property
    def logical_grid(self) -> list[list[int]]:
        return [row[1:-1] for row in self.grid[1:-1]]

    def tile_positions(self) -> list[tuple[int, int]]:
        return [
            (r, c)
            for r in range(self.rows)
            for c in range(self.cols)
            if self.grid[r][c] != 0
        ]

    def tiles_left(self) -> int:
        return sum(1 for row in self.grid for v in row if v != 0)

    def is_cleared(self) -> bool:
        return self.tiles_left() == 0

    def groups_by_type(self) -> dict[int, list[tuple[int, int]]]:
        groups: dict[int, list[tuple[int, int]]] = {}
        for r, c in self.tile_positions():
            groups.setdefault(self.grid[r][c], []).append((r, c))
        return groups

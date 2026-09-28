"""Build a solver Board from recognized tiles (PRD section 4)."""
from __future__ import annotations

from src.solver.board import Board
from .tile import Tile


class BoardBuilder:
    def build(self, tiles: list[Tile]) -> Board:
        if not tiles:
            raise ValueError("no tiles to build a board from")
        rows = max(t.row for t in tiles) + 1
        cols = max(t.col for t in tiles) + 1
        logical = [[0] * cols for _ in range(rows)]
        for tile in tiles:
            if tile.empty:
                continue
            if tile.type_id is None:
                raise ValueError(
                    f"tile ({tile.row},{tile.col}) is not empty but has no type_id; "
                    "run TileMatcher.classify() first"
                )
            logical[tile.row][tile.col] = tile.type_id
        return Board.from_logical(logical)

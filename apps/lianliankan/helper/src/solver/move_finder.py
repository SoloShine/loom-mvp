"""Move finder: search the board for a linkable pair of same-type tiles."""
from __future__ import annotations

from .board import Board, Move
from .link_solver import find_path


def find_move(board: Board, exclude: set | None = None) -> Move | None:
    """Return the first linkable pair found (scanning by type id), or None.

    `exclude` is a set of frozenset({a, b}) padded-coordinate pairs to skip,
    e.g. pairs whose execution previously failed verification.
    """
    exclude = exclude or set()
    for positions in board.groups_by_type().values():
        for i in range(len(positions)):
            for j in range(i + 1, len(positions)):
                a, b = positions[i], positions[j]
                if frozenset((a, b)) in exclude:
                    continue
                path = find_path(board, a, b)
                if path is not None:
                    return Move(a=a, b=b, path=tuple(path))
    return None


def find_all_moves(board: Board) -> list[Move]:
    """Return every currently linkable pair (useful for debugging/stats)."""
    moves: list[Move] = []
    for positions in board.groups_by_type().values():
        for i in range(len(positions)):
            for j in range(i + 1, len(positions)):
                a, b = positions[i], positions[j]
                path = find_path(board, a, b)
                if path is not None:
                    moves.append(Move(a=a, b=b, path=tuple(path)))
    return moves


def solve_board(board: Board) -> list[Move]:
    """Greedily clear the whole board, returning the sequence of moves.

    MVP behaviour: always take the first available pair; stop as soon as no
    move exists (deadlock) or the board is cleared.
    """
    work = Board(board.grid)
    moves: list[Move] = []
    while not work.is_cleared():
        move = find_move(work)
        if move is None:
            break
        moves.append(move)
        work.remove_move(move)
    return moves

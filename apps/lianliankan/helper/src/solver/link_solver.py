"""Link solver: decides whether two tiles can be connected under standard
lianliankan rules (orthogonal moves through empty cells, at most 2 turns,
paths may leave the board through the empty border ring).

The implementation is a BFS over states (row, col, direction, turns):
continuing straight keeps the turn count, changing direction adds one.
"""
from __future__ import annotations

from collections import deque

from .board import Board

DIRS: tuple[tuple[int, int], ...] = (
    (-1, 0),  # up
    (1, 0),  # down
    (0, -1),  # left
    (0, 1),  # right
)

MAX_TURNS = 2


def find_path(
    board: Board,
    a: tuple[int, int],
    b: tuple[int, int],
) -> list[tuple[int, int]] | None:
    """Return the cells visited from `a` to `b` (inclusive) if they can be
    linked, otherwise None. Cells are padded coordinates; the returned path
    contains at most 4 points (start, up to 2 corners, end).
    """
    if a == b:
        return None
    if not (board.in_bounds(a) and board.in_bounds(b)):
        return None
    value = board.get(a)
    if value == 0 or board.get(b) != value:
        return None

    # best[(r, c, dir)] = fewest turns used to stand at (r, c) moving in dir
    best: dict[tuple[int, int, int], int] = {}
    parent: dict[tuple[int, int, int], tuple[int, int, int]] = {}

    queue: deque[tuple[int, int, int, int]] = deque()
    for d, (dr, dc) in enumerate(DIRS):
        start = (a[0] + dr, a[1] + dc)
        if _passable(board, start, b):
            state = (start[0], start[1], d)
            best[state] = 0
            parent[state] = (a[0], a[1], -1)
            queue.append((*state, 0))

    while queue:
        r, c, d, turns = queue.popleft()
        if (r, c) == b:
            return _reconstruct(parent, (r, c, d))
        for nd, (dr, dc) in enumerate(DIRS):
            # continuing straight keeps the turn count; turning costs one.
            nt = turns if nd == d else turns + 1
            if nt > MAX_TURNS:
                continue
            nxt = (r + dr, c + dc)
            if not _passable(board, nxt, b):
                continue
            state = (nxt[0], nxt[1], nd)
            if best.get(state, MAX_TURNS + 1) <= nt:
                continue
            best[state] = nt
            parent[state] = (r, c, d)
            queue.append((*state, nt))
    return None


def can_link(board: Board, a: tuple[int, int], b: tuple[int, int]) -> bool:
    return find_path(board, a, b) is not None


def _passable(board: Board, pos: tuple[int, int], target: tuple[int, int]) -> bool:
    """Empty cells are passable; only the target tile itself may be entered."""
    if not board.in_bounds(pos):
        return False
    return board.get(pos) == 0 or pos == target


def _reconstruct(
    parent: dict[tuple[int, int, int], tuple[int, int, int]],
    end: tuple[int, int, int],
) -> list[tuple[int, int]]:
    states: list[tuple[int, int, int]] = []
    state: tuple[int, int, int] | None = end
    while state is not None:
        states.append(state)
        state = parent.get(state)  # the virtual start state has no parent
    states.reverse()

    start = states[0][:2]  # virtual state at tile A, direction -1
    cells = [s[:2] for s in states[1:]]  # c1 .. cn (cn == tile B)
    dirs = [s[2] for s in states[1:]]  # direction of movement into each cell
    # Keep only corner cells (direction changed between segments) plus endpoints.
    points: list[tuple[int, int]] = [start]
    for i in range(len(cells) - 1):
        if dirs[i] != dirs[i + 1]:
            points.append(cells[i])
    points.append(cells[-1])
    return points

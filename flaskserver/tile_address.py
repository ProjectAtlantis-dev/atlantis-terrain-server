"""Canonical parsing and formatting for terrain quadtree tile identifiers."""

from __future__ import annotations

from typing import TypeAlias


TileAddress: TypeAlias = tuple[int, int, int]


def parse_tile_id(tile_id: object) -> TileAddress | None:
    """Return ``(depth, column, row)`` for a valid terrain tile identifier."""
    if not isinstance(tile_id, str):
        return None
    parts = tile_id.split("-")
    if len(parts) != 3:
        return None
    try:
        address = (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None
    if any(value < 0 for value in address):
        return None
    return address


def require_tile_id(tile_id: object) -> TileAddress:
    """Parse a tile identifier or raise a consistent ``ValueError``."""
    address = parse_tile_id(tile_id)
    if address is None:
        raise ValueError(f"invalid terrain tile id: {tile_id!r}")
    return address


def format_tile_id(depth: int, column: int, row: int) -> str:
    """Format a terrain tile address using the repository's canonical form."""
    address = (int(depth), int(column), int(row))
    if any(value < 0 for value in address):
        raise ValueError(f"terrain tile address must be non-negative: {address!r}")
    return "-".join(str(value) for value in address)

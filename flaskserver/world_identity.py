"""Persistent identity for deterministic world generation."""

from __future__ import annotations

import os
import sqlite3

DEFAULT_WORLD_SEED = 1337
DEFAULT_PROCGEN_VERSION = 2


def _uint32(value: object, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if 0 <= parsed <= 0xFFFFFFFF else fallback


def ensure_world_identity(db: sqlite3.Connection) -> dict[str, int]:
    """Create-once world identity; later environment changes cannot rewrite it."""
    requested_seed = _uint32(os.environ.get("ATLANTIS_WORLD_SEED"), DEFAULT_WORLD_SEED)
    requested_version = _uint32(
        os.environ.get("ATLANTIS_PROCGEN_VERSION"), DEFAULT_PROCGEN_VERSION
    )
    db.execute(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('world_seed', ?)",
        (str(requested_seed),),
    )
    db.execute(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('procgen_version', ?)",
        (str(requested_version),),
    )
    db.commit()
    return read_world_identity(db)


def read_world_identity(db: sqlite3.Connection) -> dict[str, int]:
    rows = dict(
        db.execute(
            "SELECT key, value FROM metadata "
            "WHERE key IN ('world_seed', 'procgen_version')"
        ).fetchall()
    )
    return {
        "worldSeed": _uint32(rows.get("world_seed"), DEFAULT_WORLD_SEED),
        "procgenVersion": _uint32(
            rows.get("procgen_version"), DEFAULT_PROCGEN_VERSION
        ),
    }

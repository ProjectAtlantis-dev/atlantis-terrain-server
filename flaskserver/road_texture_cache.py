"""Persistent cache for deterministic road-painted terrain textures.

Canonical provider/cooked imagery remains in ``textures``. This table stores
the normal presentation derivative after roads and trails are painted, keyed
by the same dependency-fingerprint pattern as ``cliff_graft_assets``.
Diagnostic red/water/hydro variants never enter this cache.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import threading
from pathlib import Path

from asset_catalog import connect, paint_roads, query_roads


ROAD_TEXTURE_BAKE_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS road_texture_bakes (
    tile_id             TEXT NOT NULL,
    recipe_version      INTEGER NOT NULL,
    source_fingerprint  TEXT NOT NULL,
    road_count          INTEGER NOT NULL CHECK (road_count >= 0),
    texture             BLOB NOT NULL,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (tile_id, recipe_version),
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);
"""

_prepare_lock = threading.RLock()


def init_road_texture_bakes(db) -> None:
    db.executescript(_SCHEMA)
    db.commit()


def _intersecting_roads(
    assets_db_path: Path,
    bbox: tuple[float, float, float, float],
) -> list[dict]:
    if not assets_db_path.exists():
        return []
    db = connect(assets_db_path)
    try:
        roads = query_roads(db, bbox)
    finally:
        db.close()
    return sorted(roads, key=lambda road: str(road.get("id", "")))


def _fingerprint(tile_id: str, texture_row, roads: list[dict]) -> str:
    digest = hashlib.sha256()
    digest.update(json.dumps(
        {
            "tile": tile_id,
            "recipe": ROAD_TEXTURE_BAKE_VERSION,
            "texture_source": texture_row[1],
            "texture_updated_at": texture_row[2],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8"))
    digest.update(texture_row[0])
    digest.update(json.dumps(
        roads,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8"))
    return digest.hexdigest()


def get_or_create_road_texture(
    db,
    tile_id: str,
    bbox: tuple[float, float, float, float],
    assets_db_path: Path,
):
    """Return the persisted normal road-painted JPEG for an exact tile."""
    init_road_texture_bakes(db)
    with _prepare_lock:
        texture_row = db.execute(
            "SELECT texture, source, updated_at FROM textures WHERE tile_id = ?",
            (tile_id,),
        ).fetchone()
        if texture_row is None:
            return None
        roads = _intersecting_roads(assets_db_path, bbox)
        fingerprint = _fingerprint(tile_id, texture_row, roads)
        cached = db.execute(
            "SELECT texture, road_count, updated_at "
            "FROM road_texture_bakes "
            "WHERE tile_id = ? AND recipe_version = ? "
            "AND source_fingerprint = ?",
            (tile_id, ROAD_TEXTURE_BAKE_VERSION, fingerprint),
        ).fetchone()
        if cached is not None:
            return {
                "texture": cached[0],
                "road_count": int(cached[1]),
                "updated_at": cached[2],
                "fingerprint": fingerprint,
                "generated": False,
                "recipe_version": ROAD_TEXTURE_BAKE_VERSION,
            }

        painted, road_count = paint_roads(
            texture_row[0],
            bbox,
            assets_db_path,
            roads=roads,
        )
        updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.execute(
            "INSERT INTO road_texture_bakes "
            "(tile_id, recipe_version, source_fingerprint, road_count, "
            "texture, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(tile_id, recipe_version) DO UPDATE SET "
            "source_fingerprint=excluded.source_fingerprint, "
            "road_count=excluded.road_count, texture=excluded.texture, "
            "updated_at=excluded.updated_at",
            (
                tile_id,
                ROAD_TEXTURE_BAKE_VERSION,
                fingerprint,
                road_count,
                painted,
                updated_at,
            ),
        )
        db.commit()
        return {
            "texture": painted,
            "road_count": road_count,
            "updated_at": updated_at,
            "fingerprint": fingerprint,
            "generated": True,
            "recipe_version": ROAD_TEXTURE_BAKE_VERSION,
        }

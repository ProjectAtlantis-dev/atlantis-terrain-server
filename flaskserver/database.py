"""Accretive LOD terrain database backed by SQLite.

Stores quadtree tiles with (N+1)x(N+1) heightmaps (65x65 for 64 cells),
per-sample confidence maps for accretive updates, and geometric error for
error-based LOD traversal.

Edge sharing: adjacent tiles share one column/row of vertices at their
boundary. When a tile is written, shared edges are reconciled with neighbors
so there are never seams.

Schema:
    tiles    — one row per quadtree tile at every depth level
    metadata — database-level config (grid_resolution, max_depth, bbox)
"""

import os
import sqlite3
import zlib
import datetime
import numpy as np

from tiles import Tile, GREENLAND_BBOX
from colored_log import get_logger
from terrain_config import ENHANCE_DEPTH

log_db = get_logger("terrain.db")

# Grid resolution: 64 cells = 65 vertices per axis
GRID_N = 65

# Confidence levels — per-sample, not per-tile
CONFIDENCE = {
    'empty':      0,
    'procedural': 1,
    'parent_resampled': 2,
    'etopo':      3,
    'copernicus': 4,
    'external':   4,
    'arcticdem':  5,
    'arcticdem_10m': 6,
}

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


class TileClobberError(RuntimeError):
    """Raised when a tile write would overwrite existing payload data."""

    def __init__(self, tile_id, existing_source, incoming_source, existing_updated_at):
        self.tile_id = tile_id
        self.existing_source = existing_source
        self.incoming_source = incoming_source
        self.existing_updated_at = existing_updated_at
        super().__init__(
            f"Refusing to clobber tile {tile_id}: existing source={existing_source} "
            f"updated_at={existing_updated_at}, incoming source={incoming_source}. "
            "Pass allow_overwrite=True to replace existing data."
        )


# ---------------------------------------------------------------------------
# Compression helpers
# ---------------------------------------------------------------------------

def _compress_array(arr):
    """Compress a numpy array to a zlib blob."""
    return zlib.compress(arr.tobytes(), level=6)


def _decompress_float32(blob, shape):
    """Decompress a zlib blob to a float32 numpy array."""
    return np.frombuffer(zlib.decompress(blob), dtype=np.float32).reshape(shape).copy()


def _decompress_uint8(blob, shape):
    """Decompress a zlib blob to a uint8 numpy array."""
    return np.frombuffer(zlib.decompress(blob), dtype=np.uint8).reshape(shape).copy()


# ---------------------------------------------------------------------------
# Database open / schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tiles (
    tile_id         TEXT PRIMARY KEY,
    depth           INTEGER NOT NULL,
    col             INTEGER NOT NULL,
    row             INTEGER NOT NULL,
    x_min           REAL NOT NULL,
    y_min           REAL NOT NULL,
    x_max           REAL NOT NULL,
    y_max           REAL NOT NULL,
    parent_id       TEXT,
    geometric_error REAL NOT NULL DEFAULT 0.0,
    source          TEXT NOT NULL DEFAULT 'empty',
    updated_at      TEXT NOT NULL,
    heightmap       BLOB,
    confidence_map  BLOB
);

CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# see texture.py for the texture table


def _retire_legacy_terrain_data(db):
    """Discard data produced or retained by retired terrain pipelines.

    Bathymetry rewrote the canonical heightmap and kept a second copy in
    ``bathy_originals``.  Neither copy is trustworthy: reset every tile the
    old pipeline touched so the normal missing-tile path reloads it from the
    source COG, then remove the obsolete storage.
    """
    tables = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    reload_ids = set()

    if "bathy_originals" in tables:
        reload_ids.update(
            row[0] for row in db.execute("SELECT tile_id FROM bathy_originals")
        )

    for tile_id, blob in db.execute(
        "SELECT tile_id, confidence_map FROM tiles WHERE confidence_map IS NOT NULL"
    ):
        try:
            confidence = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
        except (TypeError, ValueError, zlib.error):
            continue
        if np.any(confidence >= 7):
            reload_ids.add(tile_id)

    if reload_ids:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.executemany(
            "UPDATE tiles SET heightmap = NULL, confidence_map = NULL, "
            "geometric_error = 0.0, source = 'empty', updated_at = ? "
            "WHERE tile_id = ?",
            ((now, tile_id) for tile_id in reload_ids),
        )
        log_db.info(
            f"Reset {len(reload_ids)} retired terrain tiles for cloud reload"
        )

    db.execute("DROP TABLE IF EXISTS bathy_originals")
    db.execute("DROP TABLE IF EXISTS google_refs")

    columns = {row[1] for row in db.execute("PRAGMA table_info(tiles)")}
    for column in ("has_sealevel_water", "has_flattened_water"):
        if column in columns:
            db.execute(f"ALTER TABLE tiles DROP COLUMN {column}")


def open_db(path=None):
    """Create or open the terrain database.

    Args:
        path: path to SQLite file. Defaults to data/terrain.db

    Returns:
        sqlite3.Connection with WAL mode and foreign keys enabled.
    """
    if path is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        path = os.path.join(DATA_DIR, "terrain.db")

    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    db.executescript(_SCHEMA)
    _retire_legacy_terrain_data(db)
    db.commit()
    for tbl in ("tiles", "metadata"):
        if tbl not in existing:
            log_db.info(f"Created table: {tbl}")

    # Ensure textures table exists (added for satellite imagery overlay)
    from texture import init_textures
    init_textures(db)

    # Semantic classifier output is deliberately a separate, initially empty
    # tile store. Heightmaps remain the canonical geometry payload.
    from classifier.storage import init_classifier_tiles
    init_classifier_tiles(db)

    return db


# ---------------------------------------------------------------------------
# Tile addressing helpers
# ---------------------------------------------------------------------------

def _tile_id(depth, col, row):
    return f"{depth}-{col}-{row}"


def _parent_id(depth, col, row):
    if depth == 0:
        return None
    return _tile_id(depth - 1, col // 2, row // 2)


def _neighbor_ids(depth, col, row):
    """Return dict of neighbor tile IDs: {direction: tile_id}.

    Only returns neighbors that could exist (non-negative col/row,
    within the grid at this depth).
    """
    max_idx = (1 << depth) - 1  # 2^depth - 1
    neighbors = {}
    if col > 0:
        neighbors['west'] = _tile_id(depth, col - 1, row)
    if col < max_idx:
        neighbors['east'] = _tile_id(depth, col + 1, row)
    if row > 0:
        neighbors['south'] = _tile_id(depth, col, row - 1)
    if row < max_idx:
        neighbors['north'] = _tile_id(depth, col, row + 1)
    return neighbors


def _tile_bbox(depth, col, row, root_bbox=None):
    """Compute the bbox for a tile from its addressing."""
    if root_bbox is None:
        root_bbox = GREENLAND_BBOX
    rx_min, ry_min, rx_max, ry_max = root_bbox
    n = 1 << depth  # 2^depth tiles per axis
    tile_w = (rx_max - rx_min) / n
    tile_h = (ry_max - ry_min) / n
    x_min = rx_min + col * tile_w
    y_min = ry_min + row * tile_h
    return (x_min, y_min, x_min + tile_w, y_min + tile_h)


# ---------------------------------------------------------------------------
# Geometric error
# ---------------------------------------------------------------------------

def compute_geometric_error(heightmap):
    """Compute geometric error for a heightmap.

    Error = max vertical difference between the heightmap and a
    2x-downsampled-then-upsampled version. This measures how much
    detail is lost by halving resolution — flat tiles get low error,
    complex terrain gets high error.

    Args:
        heightmap: float32 array of shape (N, N), N should be odd (e.g. 65)

    Returns:
        float: geometric error in meters
    """
    if heightmap is None:
        return 0.0

    h, w = heightmap.shape
    # Downsample 2x by taking every other sample
    downsampled = heightmap[::2, ::2]
    # Upsample back using bilinear interpolation (numpy only)
    dh, dw = downsampled.shape
    # Row indices in downsampled space
    row_idx = np.linspace(0, dh - 1, h)
    col_idx = np.linspace(0, dw - 1, w)
    # Integer and fractional parts
    r0 = np.floor(row_idx).astype(int)
    c0 = np.floor(col_idx).astype(int)
    r1 = np.minimum(r0 + 1, dh - 1)
    c1 = np.minimum(c0 + 1, dw - 1)
    rf = (row_idx - r0).astype(np.float32)
    cf = (col_idx - c0).astype(np.float32)
    # Bilinear interpolation
    upsampled = (
        downsampled[np.ix_(r0, c0)] * (1 - rf[:, None]) * (1 - cf[None, :]) +
        downsampled[np.ix_(r0, c1)] * (1 - rf[:, None]) * cf[None, :] +
        downsampled[np.ix_(r1, c0)] * rf[:, None] * (1 - cf[None, :]) +
        downsampled[np.ix_(r1, c1)] * rf[:, None] * cf[None, :]
    )
    # Max absolute difference
    error = float(np.max(np.abs(heightmap - upsampled)))
    return error


# ---------------------------------------------------------------------------
# Seed tiles
# ---------------------------------------------------------------------------

def seed_tiles(db, max_depth=ENHANCE_DEPTH, root_bbox=None):
    """Populate the tiles table with the full quadtree structure.

    Creates tile rows for depths 0 through max_depth with IDs, bboxes,
    and parent links. No heightmaps — those come from ingest.

    Args:
        db: sqlite3 connection
        max_depth: deepest level to seed (inclusive)
        root_bbox: root tile bbox, defaults to GREENLAND_BBOX
    """
    if root_bbox is None:
        root_bbox = GREENLAND_BBOX

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # Store metadata
    db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
               ("grid_resolution", str(GRID_N)))
    db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
               ("max_depth", str(max_depth)))
    db.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
               ("bbox", f"{root_bbox[0]},{root_bbox[1]},{root_bbox[2]},{root_bbox[3]}"))

    # Batch insert all tiles
    batch = []
    for depth in range(max_depth + 1):
        n = 1 << depth  # 2^depth tiles per axis at this level
        for col in range(n):
            for row in range(n):
                tid = _tile_id(depth, col, row)
                pid = _parent_id(depth, col, row)
                bbox = _tile_bbox(depth, col, row, root_bbox)
                batch.append((
                    tid, depth, col, row,
                    bbox[0], bbox[1], bbox[2], bbox[3],
                    pid, 0.0, 'empty', now, None, None
                ))
        # Flush every depth level to avoid huge memory
        if batch:
            db.executemany(
                "INSERT OR IGNORE INTO tiles "
                "(tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
                "parent_id, geometric_error, source, updated_at, heightmap, confidence_map) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                batch
            )
            batch.clear()

    db.commit()


# ---------------------------------------------------------------------------
# Edge reconciliation
# ---------------------------------------------------------------------------

def _reconcile_edges(db, tile_id, heightmap, confidence_map):
    """Reconcile shared edges with neighbor tiles.

    For each neighbor direction, copy the shared edge from whichever
    tile has higher confidence at those vertices. Updates both this
    tile's arrays and the neighbor's stored blobs.

    Args:
        db: sqlite3 connection
        tile_id: this tile's ID
        heightmap: float32 (N, N) — modified in-place
        confidence_map: uint8 (N, N) — modified in-place
    """
    parts = tile_id.split('-')
    depth, col, row = int(parts[0]), int(parts[1]), int(parts[2])
    neighbors = _neighbor_ids(depth, col, row)

    for direction, nbr_id in neighbors.items():
        nbr_row = db.execute(
            "SELECT heightmap, confidence_map FROM tiles WHERE tile_id = ?",
            (nbr_id,)
        ).fetchone()

        if nbr_row is None or nbr_row[0] is None:
            continue  # neighbor has no data yet

        n = heightmap.shape[0]
        nbr_hm = _decompress_float32(nbr_row[0], (n, n))
        nbr_cm = _decompress_uint8(nbr_row[1], (n, n))

        # Determine which edge is shared
        if direction == 'east':
            # Our east edge (col -1) = neighbor's west edge (col 0)
            our_edge = (slice(None), -1)
            nbr_edge = (slice(None), 0)
        elif direction == 'west':
            our_edge = (slice(None), 0)
            nbr_edge = (slice(None), -1)
        elif direction == 'north':
            our_edge = (-1, slice(None))
            nbr_edge = (0, slice(None))
        elif direction == 'south':
            our_edge = (0, slice(None))
            nbr_edge = (-1, slice(None))
        else:
            continue

        # Compare confidence at each shared vertex
        our_conf = confidence_map[our_edge]
        nbr_conf = nbr_cm[nbr_edge]

        # Where neighbor has higher or equal confidence, copy FROM neighbor TO us.
        # Equal-confidence: neighbor was written first, so it's the canonical edge.
        nbr_wins = nbr_conf >= our_conf
        if np.any(nbr_wins):
            heightmap[our_edge][nbr_wins] = nbr_hm[nbr_edge][nbr_wins]
            confidence_map[our_edge][nbr_wins] = nbr_cm[nbr_edge][nbr_wins]

        # Where we have higher confidence, copy FROM us TO neighbor
        we_win = our_conf > nbr_conf
        if np.any(we_win):
            nbr_hm[nbr_edge][we_win] = heightmap[our_edge][we_win]
            nbr_cm[nbr_edge][we_win] = confidence_map[our_edge][we_win]

            # Write updated neighbor back to DB
            nbr_error = compute_geometric_error(nbr_hm)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            db.execute(
                "UPDATE tiles SET heightmap = ?, confidence_map = ?, "
                "geometric_error = ?, updated_at = ? WHERE tile_id = ?",
                (_compress_array(nbr_hm), _compress_array(nbr_cm),
                 nbr_error, now, nbr_id)
            )


# ---------------------------------------------------------------------------
# Write / read tiles
# ---------------------------------------------------------------------------

def write_tile(
    db,
    tile_id,
    heightmap,
    confidence_map,
    source,
    reconcile=True,
    allow_overwrite=False,
):
    """Store a tile's heightmap and confidence map, compute error, reconcile edges.

    This is the main write path. It:
    1. Validates shapes
    2. Optionally reconciles shared edges with neighbors
    3. Detects and prevents accidental clobber writes by default
    4. Computes geometric error
    5. Stores compressed blobs

    Args:
        db: sqlite3 connection
        tile_id: "depth-col-row" string
        heightmap: float32 array of shape (GRID_N, GRID_N)
        confidence_map: uint8 array of shape (GRID_N, GRID_N)
        source: source name string (key in CONFIDENCE dict)
        reconcile: if True, reconcile edges with neighbors (default True)
        allow_overwrite: if True, allow replacing existing tile payloads.
            Default False — raises TileClobberError on changed existing payload.

    Returns:
        True if row written to DB, False if duplicate payload already present.
    """
    assert heightmap.shape == (GRID_N, GRID_N), \
        f"heightmap shape {heightmap.shape} != ({GRID_N}, {GRID_N})"
    assert confidence_map.shape == (GRID_N, GRID_N), \
        f"confidence_map shape {confidence_map.shape} != ({GRID_N}, {GRID_N})"
    assert heightmap.dtype == np.float32
    assert confidence_map.dtype == np.uint8

    # Make copies so we don't mutate caller's arrays
    heightmap = heightmap.copy()
    confidence_map = confidence_map.copy()

    # Reconcile shared edges with neighbors
    if reconcile:
        _reconcile_edges(db, tile_id, heightmap, confidence_map)

    # Compute geometric error
    error = compute_geometric_error(heightmap)
    hm_blob = _compress_array(heightmap)
    cm_blob = _compress_array(confidence_map)

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    if allow_overwrite:
        cursor = db.execute(
            "UPDATE tiles SET heightmap = ?, confidence_map = ?, "
            "geometric_error = ?, source = ?, updated_at = ? WHERE tile_id = ?",
            (hm_blob, cm_blob, error, source, now, tile_id)
        )
        if cursor.rowcount == 0:
            raise KeyError(f"Unknown tile_id: {tile_id}")
        db.commit()
        return True

    # Atomic no-clobber write: only populate tiles that do not yet have payloads.
    cursor = db.execute(
        "UPDATE tiles SET heightmap = ?, confidence_map = ?, "
        "geometric_error = ?, source = ?, updated_at = ? "
        "WHERE tile_id = ? AND heightmap IS NULL AND confidence_map IS NULL",
        (hm_blob, cm_blob, error, source, now, tile_id)
    )
    if cursor.rowcount == 1:
        db.commit()
        return True

    row = db.execute(
        "SELECT source, updated_at, heightmap, confidence_map "
        "FROM tiles WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()
    if row is None:
        raise KeyError(f"Unknown tile_id: {tile_id}")

    existing_source, existing_updated_at, existing_hm_blob, existing_cm_blob = row
    same_payload = (
        existing_source == source and
        existing_hm_blob == hm_blob and
        existing_cm_blob == cm_blob
    )
    if same_payload:
        return False

    raise TileClobberError(
        tile_id=tile_id,
        existing_source=existing_source,
        incoming_source=source,
        existing_updated_at=existing_updated_at,
    )


def read_tile(db, tile_id):
    """Read a tile's data from the database.

    Args:
        db: sqlite3 connection
        tile_id: "depth-col-row" string

    Returns:
        dict with keys: tile_id, depth, col, row, bbox, parent_id,
        geometric_error, source, heightmap (float32 NxN or None),
        confidence_map (uint8 NxN or None), updated_at.
        Returns None if tile_id doesn't exist.
    """
    row = db.execute(
        "SELECT tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
        "parent_id, geometric_error, source, updated_at, heightmap, confidence_map "
        "FROM tiles WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()

    if row is None:
        return None

    n = GRID_N
    hm_blob, cm_blob = row[12], row[13]

    return {
        'tile_id': row[0],
        'depth': row[1],
        'col': row[2],
        'row': row[3],
        'bbox': (row[4], row[5], row[6], row[7]),
        'parent_id': row[8],
        'geometric_error': row[9],
        'source': row[10],
        'updated_at': row[11],
        'heightmap': _decompress_float32(hm_blob, (n, n)) if hm_blob else None,
        'confidence_map': _decompress_uint8(cm_blob, (n, n)) if cm_blob else None,
    }


def read_tiles_at_depth(db, depth):
    """Read all tile IDs at a given depth.

    Args:
        db: sqlite3 connection
        depth: integer depth level

    Returns:
        list of tile_id strings
    """
    rows = db.execute(
        "SELECT tile_id FROM tiles WHERE depth = ? ORDER BY tile_id",
        (depth,)
    ).fetchall()
    return [r[0] for r in rows]


def read_tile_metadata(db, tile_id):
    """Read tile metadata without decompressing heightmap blobs.

    Returns:
        dict with tile_id, depth, col, row, bbox, geometric_error, source.
        None if tile doesn't exist.
    """
    row = db.execute(
        "SELECT tile_id, depth, col, row, x_min, y_min, x_max, y_max, "
        "geometric_error, source FROM tiles WHERE tile_id = ?",
        (tile_id,)
    ).fetchone()

    if row is None:
        return None

    return {
        'tile_id': row[0],
        'depth': row[1],
        'col': row[2],
        'row': row[3],
        'bbox': (row[4], row[5], row[6], row[7]),
        'geometric_error': row[8],
        'source': row[9],
    }


def get_metadata(db, key):
    """Read a metadata value by key."""
    row = db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def tile_count(db, depth=None, source=None):
    """Count tiles, optionally filtered by depth and/or source.

    Args:
        db: sqlite3 connection
        depth: optional depth filter
        source: optional source filter

    Returns:
        int count
    """
    query = "SELECT COUNT(*) FROM tiles WHERE 1=1"
    params = []
    if depth is not None:
        query += " AND depth = ?"
        params.append(depth)
    if source is not None:
        query += " AND source = ?"
        params.append(source)
    return db.execute(query, params).fetchone()[0]

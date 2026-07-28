"""Accretive LOD terrain database backed by SQLite.

Stores quadtree tiles with (N+1)x(N+1) heightmaps (65x65 for 64 cells),
per-sample confidence maps for accretive updates, and geometric error for
error-based LOD traversal.

Edge sharing: adjacent tiles share one column/row of vertices at their
boundary. When a tile is written, shared edges are reconciled with neighbors
so there are never seams.

Schema:
    tiles              — one row per quadtree tile at every depth level
    bathymetry         — derived underwater elevation rasters
    depth_sources      — immutable provenance for measured depth evidence
    depth_observations — normalized point depths and lower-bound constraints
    depth_assets       — original sounding/chart/raster source payloads
    depth_imports      — reproducible import audit records
    metadata           — database-level config (grid_resolution, max_depth, bbox)
"""

import os
import sqlite3
import zlib
import datetime
import numpy as np

from colored_log import get_logger
from terrain_config import GREENLAND_BBOX, MAX_TILE_DEPTH
from tile_address import format_tile_id as _tile_id, require_tile_id

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
    'cooked_dem': 5,  # derived from a stable parent; below the 10m measured rank
    'arcticdem_10m': 6,
    'official_coastline': 6,
}

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
SCHEMA_VERSION = 7
_SCHEMA_VERSION_KEY = "schema_version"


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
    dem_demanded_at TEXT,
    dem_requested_at TEXT,
    cog_requested_at TEXT,
    heightmap       BLOB,
    confidence_map  BLOB
);

CREATE TABLE IF NOT EXISTS metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coastline_masks (
    tile_id    TEXT PRIMARY KEY,
    width      INTEGER NOT NULL CHECK (width > 0),
    height     INTEGER NOT NULL CHECK (height > 0),
    mask       BLOB NOT NULL,
    source     TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);

-- Åbent Land's rendered WMS exposes useful general hydrography, including
-- lakes and watercourses. Keep the raw source separate so only components
-- flood-connected to trusted tidal masks or a wholly sea-level DEM tile can
-- participate in sea flattening.
CREATE TABLE IF NOT EXISTS hydrography_masks (
    tile_id    TEXT PRIMARY KEY,
    width      INTEGER NOT NULL CHECK (width > 0),
    height     INTEGER NOT NULL CHECK (height > 0),
    mask       BLOB NOT NULL,
    source     TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (tile_id) REFERENCES tiles(tile_id) ON DELETE CASCADE
);

-- Real underwater elevations are independent of the canonical land DEM.
-- Rows normally arrive at depth 8; the read path crops/resamples them to the
-- visible terrain LOD and applies negative finite samples after the synthetic
-- -5 m water floor.
CREATE TABLE IF NOT EXISTS bathymetry (
    tile_id    TEXT PRIMARY KEY,
    heightmap  BLOB NOT NULL,
    water_px   INTEGER NOT NULL,
    min_z      REAL NOT NULL,
    max_z      REAL NOT NULL,
    source     TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

-- Source observations are evidence, not generated terrain. Keep their
-- provenance and original payloads independent from the derived bathymetry
-- table so an algorithm can be rebuilt or scored without circular validation.
CREATE TABLE IF NOT EXISTS depth_sources (
    source_id            TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    citation             TEXT NOT NULL,
    source_url           TEXT NOT NULL,
    doi                  TEXT,
    provider             TEXT NOT NULL,
    license              TEXT,
    data_kind            TEXT NOT NULL CHECK (
        data_kind IN (
            'point_observations',
            'gridded_bathymetry',
            'nautical_chart',
            'mixed'
        )
    ),
    original_filename    TEXT,
    content_sha256       TEXT CHECK (
        content_sha256 IS NULL OR length(content_sha256) = 64
    ),
    source_metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(source_metadata_json)),
    retrieved_at         TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

-- ``seafloor_depth`` is a measured/charted bottom depth. ``minimum_depth`` is
-- only proof that the water column reaches at least this depth, for example a
-- CTD cast endpoint. The CHECK makes it impossible to silently conflate them.
CREATE TABLE IF NOT EXISTS depth_observations (
    observation_id       TEXT PRIMARY KEY,
    source_id            TEXT NOT NULL,
    source_record_id     TEXT NOT NULL,
    longitude_deg        REAL NOT NULL CHECK (
        longitude_deg >= -180.0 AND longitude_deg <= 180.0
    ),
    latitude_deg         REAL NOT NULL CHECK (
        latitude_deg >= -90.0 AND latitude_deg <= 90.0
    ),
    depth_m              REAL NOT NULL CHECK (depth_m >= 0.0),
    evidence_kind        TEXT NOT NULL CHECK (
        evidence_kind IN ('seafloor_depth', 'minimum_depth')
    ),
    measurement_method   TEXT NOT NULL,
    observed_at          TEXT,
    horizontal_datum     TEXT NOT NULL,
    vertical_datum       TEXT NOT NULL,
    horizontal_accuracy_m REAL CHECK (
        horizontal_accuracy_m IS NULL OR horizontal_accuracy_m >= 0.0
    ),
    vertical_accuracy_m  REAL CHECK (
        vertical_accuracy_m IS NULL OR vertical_accuracy_m >= 0.0
    ),
    properties_json      TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(properties_json)),
    imported_at          TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES depth_sources(source_id)
        ON DELETE RESTRICT,
    UNIQUE (source_id, source_record_id)
);
CREATE INDEX IF NOT EXISTS depth_observations_location
    ON depth_observations(longitude_deg, latitude_deg);
CREATE INDEX IF NOT EXISTS depth_observations_evidence
    ON depth_observations(evidence_kind, measurement_method);

-- Preserve original source files in the DB as auditable evidence. A GeoTIFF
-- or XYZ grid can remain an asset instead of expanding millions of grid cells
-- into point rows; point datasets may retain both the raw asset and normalized
-- observations.
CREATE TABLE IF NOT EXISTS depth_assets (
    asset_id             TEXT PRIMARY KEY,
    source_id            TEXT NOT NULL,
    filename             TEXT NOT NULL,
    media_type           TEXT NOT NULL,
    payload              BLOB NOT NULL,
    byte_length          INTEGER NOT NULL CHECK (
        byte_length >= 0 AND byte_length = length(payload)
    ),
    content_sha256       TEXT NOT NULL CHECK (length(content_sha256) = 64),
    evidence_kind        TEXT NOT NULL CHECK (
        evidence_kind IN ('seafloor_depth', 'minimum_depth', 'mixed')
    ),
    measurement_method   TEXT NOT NULL,
    horizontal_crs       TEXT NOT NULL,
    vertical_datum       TEXT NOT NULL,
    resolution_m         REAL CHECK (
        resolution_m IS NULL OR resolution_m > 0.0
    ),
    west_deg             REAL,
    south_deg            REAL,
    east_deg             REAL,
    north_deg            REAL,
    metadata_json        TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json)),
    imported_at          TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES depth_sources(source_id)
        ON DELETE RESTRICT,
    UNIQUE (source_id, filename, content_sha256),
    CHECK (
        (west_deg IS NULL AND south_deg IS NULL
         AND east_deg IS NULL AND north_deg IS NULL)
        OR
        (west_deg >= -180.0 AND west_deg <= 180.0
         AND east_deg >= -180.0 AND east_deg <= 180.0
         AND south_deg >= -90.0 AND south_deg <= 90.0
         AND north_deg >= -90.0 AND north_deg <= 90.0
         AND west_deg <= east_deg AND south_deg <= north_deg)
    )
);
CREATE INDEX IF NOT EXISTS depth_assets_evidence
    ON depth_assets(evidence_kind, measurement_method);

CREATE TABLE IF NOT EXISTS depth_imports (
    import_id          TEXT PRIMARY KEY,
    source_id          TEXT NOT NULL,
    importer           TEXT NOT NULL,
    importer_version   INTEGER NOT NULL CHECK (importer_version > 0),
    input_sha256       TEXT NOT NULL CHECK (length(input_sha256) = 64),
    source_row_count   INTEGER NOT NULL CHECK (source_row_count >= 0),
    observation_count  INTEGER NOT NULL CHECK (observation_count >= 0),
    asset_count        INTEGER NOT NULL CHECK (asset_count >= 0),
    started_at         TEXT NOT NULL,
    completed_at       TEXT NOT NULL,
    notes              TEXT,
    FOREIGN KEY (source_id) REFERENCES depth_sources(source_id)
        ON DELETE RESTRICT
);
"""

# see texture.py for the texture table


def _migrate_to_v1(db):
    """Remove storage and data left by retired terrain pipelines.

    Bathymetry rewrote the canonical heightmap and kept a second copy in
    ``bathy_originals``.  Neither copy is trustworthy: reset every tile the
    old pipeline touched so the normal missing-tile path reloads it from the
    source COG, then remove the obsolete storage. The seam and water-mask
    tables belonged to the same retired pipeline and have no remaining readers.
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
    db.execute("DROP TABLE IF EXISTS seam_jobs")
    db.execute("DROP TABLE IF EXISTS water_masks")

    columns = {row[1] for row in db.execute("PRAGMA table_info(tiles)")}
    for column in ("has_sealevel_water", "has_flattened_water"):
        if column in columns:
            db.execute(f"ALTER TABLE tiles DROP COLUMN {column}")


def _migrate_to_v2(db):
    """Queue cached terrain for a non-destructive coastline-aware refresh."""
    source_map = {
        "arcticdem": "unmasked_arcticdem",
        "arcticdem_10m": "unmasked_arcticdem_10m",
        "copernicus": "unmasked_copernicus",
        "parent_resampled": "unmasked_parent_resampled",
    }
    upgrade_ids = [
        row[0]
        for row in db.execute(
            f"SELECT tile_id FROM tiles WHERE source IN "
            f"({','.join('?' for _ in source_map)})",
            tuple(source_map),
        )
    ]
    for old_source, queued_source in source_map.items():
        db.execute(
            "UPDATE tiles SET source = ? WHERE source = ?",
            (queued_source, old_source),
        )

    # Old no-data rows have no payload worth preserving. Reopen them so the
    # official mask can resolve all-ocean tiles even when both DEMs are empty.
    no_data_ids = [
        row[0]
        for row in db.execute("SELECT tile_id FROM tiles WHERE source = 'no_data'")
    ]
    if no_data_ids:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.executemany(
            "UPDATE tiles SET heightmap = NULL, confidence_map = NULL, "
            "geometric_error = 0.0, source = 'empty', updated_at = ? "
            "WHERE tile_id = ?",
            ((now, tile_id) for tile_id in no_data_ids),
        )

    if upgrade_ids:
        tables = {
            row[0]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "classifier_tiles" in tables:
            db.executemany(
                "DELETE FROM classifier_tiles WHERE tile_id = ?",
                ((tile_id,) for tile_id in upgrade_ids),
            )
        log_db.info(
            f"Queued {len(upgrade_ids)} terrain tiles for official coastline refresh"
        )


def _migrate_to_v3(db):
    """Queue heightmaps modified by schema v2 for raw cloud restoration."""
    source_map = {
        "arcticdem_10m": "clobbered_arcticdem_10m",
        "copernicus": "clobbered_copernicus",
        "parent_resampled": "clobbered_parent_resampled",
        "official_coastline": "clobbered_official_coastline",
    }
    restored_count = 0
    for old_source, queued_source in source_map.items():
        cursor = db.execute(
            "UPDATE tiles SET source = ? WHERE source = ?",
            (queued_source, old_source),
        )
        restored_count += cursor.rowcount
    if restored_count:
        log_db.info(
            f"Queued {restored_count} coastline-modified heightmaps for raw restoration"
        )


def _migrate_to_v4(db):
    """Separate rendered-WMS hydrography from tidal coastline authority."""
    source = "govmin_gl_aabent_land"
    tile_ids = [
        row[0] for row in db.execute(
            "SELECT tile_id FROM coastline_masks WHERE source = ?", (source,)
        )
    ]
    if not tile_ids:
        return
    db.execute(
        "INSERT OR REPLACE INTO hydrography_masks "
        "(tile_id, width, height, mask, source, version, updated_at) "
        "SELECT tile_id, width, height, mask, source, version, updated_at "
        "FROM coastline_masks WHERE source = ?",
        (source,),
    )
    db.execute("DELETE FROM coastline_masks WHERE source = ?", (source,))
    tables = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    if "classifier_tiles" in tables:
        db.executemany(
            "DELETE FROM classifier_tiles WHERE tile_id = ?",
            ((tile_id,) for tile_id in tile_ids),
        )
    if "terrain_seam_cache" in tables:
        db.executemany(
            "DELETE FROM terrain_seam_cache WHERE tile_a = ? OR tile_b = ?",
            ((tile_id, tile_id) for tile_id in tile_ids),
        )
    log_db.info(
        f"Separated {len(tile_ids)} Åbent Land hydrography masks from tidal coastline masks"
    )


def _migrate_to_v5(db):
    """Persist demand and provider-request evidence for terrain DEM tiles."""
    columns = {row[1] for row in db.execute("PRAGMA table_info(tiles)")}
    if "dem_demanded_at" not in columns:
        db.execute("ALTER TABLE tiles ADD COLUMN dem_demanded_at TEXT")
    if "dem_requested_at" not in columns:
        db.execute("ALTER TABLE tiles ADD COLUMN dem_requested_at TEXT")
    if "cog_requested_at" not in columns:
        db.execute("ALTER TABLE tiles ADD COLUMN cog_requested_at TEXT")


def _migrate_to_v6(db):
    """Register the separately stored, read-time bathymetry overlay."""
    # ``_SCHEMA`` creates a missing table before migrations run. An underwater
    # producer may already have created and populated it, so validate the
    # shared contract without rebuilding or touching those rows.
    required = {
        "tile_id", "heightmap", "water_px", "min_z", "max_z",
        "source", "version", "updated_at",
    }
    columns = {
        row[1] for row in db.execute("PRAGMA table_info(bathymetry)")
    }
    missing = required - columns
    if missing:
        raise RuntimeError(
            "bathymetry table is missing required columns: "
            + ", ".join(sorted(missing))
        )


def _migrate_to_v7(db):
    """Register measured depth evidence separately from derived bathymetry."""
    required = {
        "depth_sources": {
            "source_id", "title", "citation", "source_url", "doi",
            "provider", "license", "data_kind", "original_filename",
            "content_sha256", "source_metadata_json", "retrieved_at",
            "updated_at",
        },
        "depth_observations": {
            "observation_id", "source_id", "source_record_id",
            "longitude_deg", "latitude_deg", "depth_m", "evidence_kind",
            "measurement_method", "observed_at", "horizontal_datum",
            "vertical_datum", "horizontal_accuracy_m",
            "vertical_accuracy_m", "properties_json", "imported_at",
        },
        "depth_assets": {
            "asset_id", "source_id", "filename", "media_type", "payload",
            "byte_length", "content_sha256", "evidence_kind",
            "measurement_method", "horizontal_crs", "vertical_datum",
            "resolution_m", "west_deg", "south_deg", "east_deg",
            "north_deg", "metadata_json", "imported_at",
        },
        "depth_imports": {
            "import_id", "source_id", "importer", "importer_version",
            "input_sha256", "source_row_count", "observation_count",
            "asset_count", "started_at", "completed_at", "notes",
        },
    }
    for table, expected in required.items():
        columns = {
            row[1] for row in db.execute(f"PRAGMA table_info({table})")
        }
        missing = expected - columns
        if missing:
            raise RuntimeError(
                f"{table} table is missing required columns: "
                + ", ".join(sorted(missing))
            )


def _migrate_schema(db):
    row = db.execute(
        "SELECT value FROM metadata WHERE key = ?", (_SCHEMA_VERSION_KEY,)
    ).fetchone()
    version = int(row[0]) if row is not None else 0
    if version > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema version {version} is newer than supported "
            f"version {SCHEMA_VERSION}"
        )
    if version < 1:
        _migrate_to_v1(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "1"),
        )
        version = 1
    if version < 2:
        _migrate_to_v2(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "2"),
        )
        version = 2
    if version < 3:
        _migrate_to_v3(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "3"),
        )
        version = 3
    if version < 4:
        _migrate_to_v4(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "4"),
        )
        version = 4
    if version < 5:
        _migrate_to_v5(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "5"),
        )
        version = 5
    if version < 6:
        _migrate_to_v6(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "6"),
        )
        version = 6
    if version < 7:
        _migrate_to_v7(db)
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            (_SCHEMA_VERSION_KEY, "7"),
        )


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
    _migrate_schema(db)
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

    from cliff_graft_cache import init_cliff_graft_assets
    init_cliff_graft_assets(db)

    from road_texture_cache import init_road_texture_bakes
    init_road_texture_bakes(db)

    from terrain_seams import init_seam_cache
    init_seam_cache(db)
    if "terrain_seam_cache" not in existing:
        log_db.info("Created table: terrain_seam_cache")

    # Install invalidation triggers after the seam table exists. Bathymetry is
    # intentionally written by a separate team, possibly through raw SQL, so
    # correctness cannot depend on callers using a Python helper.
    from bathymetry import init_bathymetry
    init_bathymetry(db)

    from coastline import ensure_water_floor_version
    ensure_water_floor_version(db)

    return db


# ---------------------------------------------------------------------------
# Tile addressing helpers
# ---------------------------------------------------------------------------

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

def seed_tiles(db, max_depth=MAX_TILE_DEPTH, root_bbox=None):
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
    depth, col, row = require_tile_id(tile_id)
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
            from terrain_seams import invalidate_tile_seams
            invalidated = invalidate_tile_seams(db, nbr_id)
            if invalidated:
                log_db.info(
                    f"[seam-cache] {nbr_id}: invalidated {invalidated} seams"
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
        from terrain_seams import invalidate_tile_seams
        invalidated = invalidate_tile_seams(db, tile_id)
        if invalidated:
            log_db.info(f"[seam-cache] {tile_id}: invalidated {invalidated} seams")
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
        from terrain_seams import invalidate_tile_seams
        invalidated = invalidate_tile_seams(db, tile_id)
        if invalidated:
            log_db.info(f"[seam-cache] {tile_id}: invalidated {invalidated} seams")
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

    raw_heightmap = _decompress_float32(hm_blob, (n, n)) if hm_blob else None
    from coastline import effective_heightmap

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
        'heightmap': effective_heightmap(db, tile_id, raw_heightmap),
        'confidence_map': _decompress_uint8(cm_blob, (n, n)) if cm_blob else None,
    }


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

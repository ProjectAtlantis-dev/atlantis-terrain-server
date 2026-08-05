"""Terrain seam repair and its exact-key persistent cache.

The geometry algorithm operates on tile dictionaries. Persistence is isolated
behind ``SqliteSeamCache`` so repair remains usable without a database.
"""

import datetime
import sqlite3

import numpy as np

from colored_log import get_logger
from tile_address import require_tile_id as _tile_address

log = get_logger("terrain.seams")


SEAM_CACHE_SCHEMA = """
CREATE TABLE IF NOT EXISTS terrain_seam_cache (
    tile_a      TEXT NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('west', 'east', 'south', 'north')),
    tile_b      TEXT NOT NULL,
    edge        BLOB NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (tile_a, direction, tile_b)
);
CREATE INDEX IF NOT EXISTS terrain_seam_cache_tile_b
    ON terrain_seam_cache (tile_b);
"""


class SqliteSeamCache:
    """Exact primary-key lookup for repaired physical terrain edges."""

    def __init__(self, db, busy_timeout_ms=30000):
        self.db = db
        # Restored after each best-effort write, so unrelated statements on
        # this connection keep the patience they were configured with.
        self._busy_timeout_ms = int(busy_timeout_ms)
        self.skipped_busy = 0

    def get(self, key, sample_count):
        row = self.db.execute(
            "SELECT edge FROM terrain_seam_cache "
            "WHERE tile_a = ? AND direction = ? AND tile_b = ?",
            key,
        ).fetchone()
        if row is None:
            return None
        try:
            edge = np.frombuffer(row[0], dtype=np.float32)
        except (TypeError, ValueError) as exc:
            log.warning(
                f"[seam-cache] corrupt edge for {key}: "
                f"{type(exc).__name__}: {exc}; recomputing"
            )
            return None
        if edge.size != sample_count:
            log.warning(
                f"[seam-cache] wrong edge size for {key}: "
                f"{edge.size}, expected {sample_count}; recomputing"
            )
            return None
        return edge.copy()

    def put(self, key, edge):
        """Best-effort write. A busy database is not an error here.

        This runs inside the interactive tile query, which is otherwise a pure
        read. WAL lets readers run during a write but still permits only one
        writer, so with the default 30s busy_timeout this INSERT would queue
        behind the background mask worker — measured at 4.4s, blocking two
        camera polls at once. The seam edge is recomputed cheaply on the next
        request, so skipping the write costs far less than waiting for it.
        """
        values = np.asarray(edge, dtype=np.float32)
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            self.db.execute("PRAGMA busy_timeout=50")
            self.db.execute(
                "INSERT INTO terrain_seam_cache "
                "(tile_a, direction, tile_b, edge, updated_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(tile_a, direction, tile_b) DO UPDATE SET "
                "edge = excluded.edge, updated_at = excluded.updated_at",
                (*key, values.tobytes(), now),
            )
            self.skipped_busy = 0
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc) and "busy" not in str(exc):
                raise
            self.skipped_busy = getattr(self, "skipped_busy", 0) + 1
        finally:
            # Restore the connection's normal patience for everything else.
            self.db.execute(f"PRAGMA busy_timeout={self._busy_timeout_ms}")


def init_seam_cache(db):
    db.executescript(SEAM_CACHE_SCHEMA)


def invalidate_tile_seams(db, tile_id):
    """Delete every cached physical seam touching ``tile_id``."""
    cursor = db.execute(
        "DELETE FROM terrain_seam_cache WHERE tile_a = ? OR tile_b = ?",
        (tile_id, tile_id),
    )
    return cursor.rowcount


def repair_lod_seams(tiles, cache=None):
    """Make rendered tile edges agree, modifying heightmaps in place.

    Same-depth neighbors share the average of their two boundary samples.
    When a same-depth neighbor is absent but a coarser rendered tile covers
    that area, the fine boundary is sampled from the coarse heightmap so it
    follows the exact edge represented by the coarse mesh.

    Returns counters describing the repairs performed.
    """
    repairs = {
        "same_depth": 0,
        "cross_lod": 0,
        "cache_hits": 0,
        "cache_misses": 0,
        "cache_writes": 0,
    }
    if not tiles:
        return repairs

    by_address = {}
    for tile in tiles:
        depth, col, row = _tile_address(tile["id"])
        by_address[(depth, col, row)] = tile

    for tile in tiles:
        heightmap = tile["heightmap"]
        if heightmap is None:
            continue

        depth, col, row = _tile_address(tile["id"])
        neighbors = {
            "west": (depth, col - 1, row),
            "east": (depth, col + 1, row),
            "south": (depth, col, row - 1),
            "north": (depth, col, row + 1),
        }

        for direction, address in neighbors.items():
            _, neighbor_col, neighbor_row = address
            if neighbor_col < 0 or neighbor_row < 0:
                continue

            neighbor = by_address.get(address)
            if neighbor is not None:
                neighbor_heightmap = neighbor["heightmap"]
                if neighbor_heightmap is None:
                    continue
                # Each same-depth pair is repaired once. West and south are
                # handled when their neighbor visits its east or north edge.
                if direction == "east":
                    key = (tile["id"], direction, neighbor["id"])
                    edge = _cached_edge(cache, key, heightmap.shape[0], repairs)
                    if edge is None:
                        edge = (heightmap[:, -1] + neighbor_heightmap[:, 0]) * 0.5
                        _store_edge(cache, key, edge, repairs)
                    heightmap[:, -1] = edge
                    neighbor_heightmap[:, 0] = edge
                    repairs["same_depth"] += 1
                elif direction == "north":
                    key = (tile["id"], direction, neighbor["id"])
                    edge = _cached_edge(cache, key, heightmap.shape[1], repairs)
                    if edge is None:
                        edge = (heightmap[-1, :] + neighbor_heightmap[0, :]) * 0.5
                        _store_edge(cache, key, edge, repairs)
                    heightmap[-1, :] = edge
                    neighbor_heightmap[0, :] = edge
                    repairs["same_depth"] += 1
                continue

            coarse = find_coarser_covering_tile(
                by_address, depth, col, row, direction
            )
            if coarse is None or coarse["heightmap"] is None:
                continue

            key = (tile["id"], direction, coarse["id"])
            sample_count = _edge_sample_count(heightmap, direction)
            edge = _cached_edge(cache, key, sample_count, repairs)
            if edge is None:
                edge = sample_coarse_edge(
                    tile["bbox"],
                    coarse["heightmap"],
                    coarse["bbox"],
                    direction,
                    sample_count,
                )
                _store_edge(cache, key, edge, repairs)
            _apply_edge(heightmap, direction, edge)
            repairs["cross_lod"] += 1

    return repairs


def find_coarser_covering_tile(by_address, depth, col, row, direction):
    """Find the rendered coarser leaf covering a missing neighbor."""
    if direction == "west":
        neighbor_col, neighbor_row = col - 1, row
    elif direction == "east":
        neighbor_col, neighbor_row = col + 1, row
    elif direction == "south":
        neighbor_col, neighbor_row = col, row - 1
    elif direction == "north":
        neighbor_col, neighbor_row = col, row + 1
    else:
        return None

    coarse_depth = depth
    for _ in range(depth):
        coarse_depth -= 1
        neighbor_col //= 2
        neighbor_row //= 2
        coarse = by_address.get((coarse_depth, neighbor_col, neighbor_row))
        if coarse is not None:
            return coarse
    return None


def sample_coarse_edge(fine_bbox, coarse_heightmap, coarse_bbox, direction,
                       sample_count):
    """Return fine-resolution samples from one edge of a coarse heightmap."""
    fine_x_min, fine_y_min, fine_x_max, fine_y_max = fine_bbox
    coarse_x_min, coarse_y_min, coarse_x_max, coarse_y_max = coarse_bbox

    if direction == "west":
        edge_x = np.full(sample_count, fine_x_min)
        edge_y = np.linspace(fine_y_min, fine_y_max, sample_count)
    elif direction == "east":
        edge_x = np.full(sample_count, fine_x_max)
        edge_y = np.linspace(fine_y_min, fine_y_max, sample_count)
    elif direction == "south":
        edge_x = np.linspace(fine_x_min, fine_x_max, sample_count)
        edge_y = np.full(sample_count, fine_y_min)
    elif direction == "north":
        edge_x = np.linspace(fine_x_min, fine_x_max, sample_count)
        edge_y = np.full(sample_count, fine_y_max)
    else:
        raise ValueError(f"unknown seam direction: {direction}")

    coarse_rows, coarse_cols = coarse_heightmap.shape
    x_fraction = (
        (edge_x - coarse_x_min) / (coarse_x_max - coarse_x_min)
        * (coarse_cols - 1)
    )
    y_fraction = (
        (edge_y - coarse_y_min) / (coarse_y_max - coarse_y_min)
        * (coarse_rows - 1)
    )

    x0 = np.clip(np.floor(x_fraction).astype(int), 0, coarse_cols - 2)
    y0 = np.clip(np.floor(y_fraction).astype(int), 0, coarse_rows - 2)
    x1 = x0 + 1
    y1 = y0 + 1
    x_amount = x_fraction - x0
    y_amount = y_fraction - y0

    values = (
        coarse_heightmap[y0, x0] * (1 - x_amount) * (1 - y_amount)
        + coarse_heightmap[y0, x1] * x_amount * (1 - y_amount)
        + coarse_heightmap[y1, x0] * (1 - x_amount) * y_amount
        + coarse_heightmap[y1, x1] * x_amount * y_amount
    )

    return values.astype(np.float32)


def _cached_edge(cache, key, sample_count, repairs):
    if cache is None:
        return None
    edge = cache.get(key, sample_count)
    if edge is None:
        repairs["cache_misses"] += 1
    else:
        repairs["cache_hits"] += 1
    return edge


def _store_edge(cache, key, edge, repairs):
    if cache is None:
        return
    cache.put(key, edge)
    repairs["cache_writes"] += 1


def _edge_sample_count(heightmap, direction):
    return heightmap.shape[0] if direction in ("west", "east") else heightmap.shape[1]


def _apply_edge(heightmap, direction, edge):
    if direction == "west":
        heightmap[:, 0] = edge
    elif direction == "east":
        heightmap[:, -1] = edge
    elif direction == "south":
        heightmap[0, :] = edge
    elif direction == "north":
        heightmap[-1, :] = edge
    else:
        raise ValueError(f"unknown seam direction: {direction}")

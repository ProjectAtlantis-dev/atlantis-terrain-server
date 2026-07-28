"""Greenland tidal coastline and separately retained Open Land hydrography.

The ASIAQ technical basemap contains an excellent ``KYSTLINJE`` layer, but its
free downloads cover towns and settlements only (the Nuuk file is roughly
8 x 9 km). Dataforsyningen's GTK50 ``tidalwater_s`` vectors are the sea
authority used for terrain. The Government of Greenland's rendered
``gl_aabent_land`` WMS contains useful lakes and watercourses too, so its blue
water pixels are retained as hydrography but never treated as tidal sea.

The WMS is rendered rather than a feature service. We request an
oversampled map and classify its distinctive blue water fill, then aggregate
each block down to one terrain vertex.  Oversampling makes labels, grid lines,
and contours minority pixels instead of holes in the water mask.
"""
from __future__ import annotations

import datetime
import io
import os
import threading
import urllib.parse
import urllib.request
import zlib
from typing import cast

import numpy as np
from PIL import Image

from colored_log import get_logger
from tile_address import parse_tile_id


log_coast = get_logger("terrain.coastline")

OFFICIAL_COASTLINE_VERSION = 1
HYDROGRAPHY_SOURCE = "govmin_gl_aabent_land"

# Masked water is dropped below sea level at read time so a sea-level water
# surface has volume above the seabed. Bump WATER_FLOOR_VERSION whenever the
# derived geometry changes: open_db() flushes every cached seam on mismatch.
WATER_FLOOR_DROP_M = 5.0
WATER_FLOOR_VERSION = 7
SEA_SEED_MAX_ELEV_M = 0.5
_WMS_URL = "https://gis.govmin.gl/geoserver/wms"
_WMS_LAYER = "Greenland:gl_aabent_land"
_OVERSAMPLE = 8

# Terrain tiles are read repeatedly while the camera is stationary.  Keep the
# operational proof useful without emitting the same coastline line on every
# /api/tiles request.
_logged_effective_tiles: set[str] = set()
_logged_effective_tiles_lock = threading.Lock()
_connected_hydro_cache: dict[tuple[str, int], tuple[tuple, dict[str, np.ndarray]]] = {}
_connected_hydro_cache_lock = threading.Lock()


def _fetch_url(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "atlantis-terrain/official-coastline"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _water_pixels(rgb: np.ndarray) -> np.ndarray:
    """Identify the blue water cartography without accepting white ice/land."""
    values = rgb.astype(np.int16)
    red, green, blue = values[..., 0], values[..., 1], values[..., 2]
    return (
        (blue >= 145)
        & ((blue - red) >= 18)
        & ((green - red) >= 10)
        & ((blue - green) >= 12)
    )


def fetch_official_water_mask(bbox, resolution: int) -> np.ndarray | None:
    """Return a south-first boolean sea mask for an EPSG:3413 bbox.

    ``None`` means the remote hydrography service was unavailable or returned
    an invalid response. Callers must retain the unmodified DEM in that case.
    """
    sample_resolution = resolution * _OVERSAMPLE
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.1.1",  # stable x/y bbox order
        "REQUEST": "GetMap",
        "LAYERS": _WMS_LAYER,
        "STYLES": "",
        "SRS": "EPSG:3413",
        "BBOX": ",".join(str(float(value)) for value in bbox),
        "WIDTH": str(sample_resolution),
        "HEIGHT": str(sample_resolution),
        "FORMAT": "image/png",
    }
    url = f"{_WMS_URL}?{urllib.parse.urlencode(params)}"

    try:
        payload = _fetch_url(url)
        with Image.open(io.BytesIO(payload)) as image:
            rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
        expected = (sample_resolution, sample_resolution, 3)
        if rgb.shape != expected:
            raise ValueError(f"unexpected WMS image shape {rgb.shape}, wanted {expected}")

        high_res = _water_pixels(rgb)
        # WMS rows are north-first. Aggregate first, then flip to the database's
        # south-first heightmap convention.
        fractions = high_res.reshape(
            resolution, _OVERSAMPLE, resolution, _OVERSAMPLE
        ).mean(axis=(1, 3))
        return np.flipud(fractions >= 0.45)
    except Exception as exc:
        log_coast.warning(
            f"Official coastline unavailable for bbox="
            f"[{bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}]: "
            f"{type(exc).__name__}: {exc}"
        )
        return None


def apply_water_mask(heightmap, water):
    """Return derived render geometry without mutating the raw DEM."""
    if heightmap is None:
        return None
    result = np.asarray(heightmap, dtype=np.float32).copy()
    water = np.asarray(water, dtype=bool)
    if water.shape != result.shape:
        raise ValueError(
            f"water mask shape {water.shape} does not match DEM {result.shape}"
        )
    floor = np.float32(-WATER_FLOOR_DROP_M)
    # This is a fallback seabed, not a maximum-elevation clamp. Assigning the
    # exact floor also erases any retired -3/-10 m synthetic values that may
    # survive in derived child DEMs. Real depths are applied separately after
    # this step from the bathymetry table.
    result[water] = floor
    return result


def _write_mask(
    db,
    table: str,
    tile_id: str,
    water,
    source: str,
    version: int,
) -> None:
    mask = np.asarray(water, dtype=np.uint8)
    if mask.ndim != 2:
        raise ValueError("water mask must be a 2D array")
    db.execute(
        f"INSERT INTO {table} "
        "(tile_id, width, height, mask, source, version, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(tile_id) DO UPDATE SET width=excluded.width, "
        "height=excluded.height, mask=excluded.mask, source=excluded.source, "
        "version=excluded.version, updated_at=excluded.updated_at",
        (
            tile_id,
            int(mask.shape[1]),
            int(mask.shape[0]),
            zlib.compress(mask.tobytes(), level=6),
            source,
            version,
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
        ),
    )
    db.commit()
    with _connected_hydro_cache_lock:
        _connected_hydro_cache.clear()


def write_water_mask(db, tile_id: str, water, source="gtk50_vector", version=2) -> None:
    """Store an authoritative tidal-sea mask used by terrain rendering."""
    _write_mask(db, "coastline_masks", tile_id, water, source, version)
    # The canonical DEM did not change, but its derived render edge may have.
    from terrain_seams import invalidate_tile_seams

    invalidate_tile_seams(db, tile_id)
    db.commit()


def write_hydrography_mask(
    db, tile_id: str, water,
    source: str = HYDROGRAPHY_SOURCE,
    version: int = OFFICIAL_COASTLINE_VERSION,
) -> None:
    """Store general WMS hydrography without granting it sea authority."""
    _write_mask(db, "hydrography_masks", tile_id, water, source, version)


def read_water_mask(db, tile_id: str) -> np.ndarray | None:
    """Authoritative tidal sea plus Åbent Land water connected to that sea."""
    authoritative = _read_mask(db, "coastline_masks", tile_id)
    hydro = _read_mask(db, "hydrography_masks", tile_id)
    if hydro is None:
        return authoritative
    connected = _connected_hydrography_for_tile(db, tile_id)
    if connected is None or not np.any(connected):
        return authoritative
    if authoritative is None:
        return connected
    if authoritative.shape != connected.shape:
        raise ValueError(
            f"coastline/hydrography mask shape mismatch for {tile_id}: "
            f"{authoritative.shape} vs {connected.shape}"
        )
    return authoritative | connected


def read_hydrography_mask(db, tile_id: str) -> np.ndarray | None:
    """Read Åbent Land hydrography at the requested terrain tile LOD.

    Hydrography is currently ingested at depth 12, but texture demand includes
    coarser parents. Assemble those parents from their nearest stored
    descendants so the BLUE diagnostic does not silently disappear with LOD.
    """
    exact = _read_mask(db, "hydrography_masks", tile_id)
    if exact is not None:
        return exact

    parsed = parse_tile_id(tile_id)
    if parsed is None:
        return None
    depth, column, row = parsed

    max_depth_row = db.execute(
        "SELECT MAX(t.depth) FROM hydrography_masks m "
        "JOIN tiles t ON t.tile_id = m.tile_id"
    ).fetchone()
    max_depth = (
        int(max_depth_row[0])
        if max_depth_row and max_depth_row[0] is not None
        else depth
    )
    for descendant_depth in range(depth + 1, max_depth + 1):
        scale = 1 << (descendant_depth - depth)
        rows = db.execute(
            "SELECT t.col, t.row, m.width, m.height, m.mask "
            "FROM hydrography_masks m JOIN tiles t ON t.tile_id = m.tile_id "
            "WHERE t.depth = ? AND t.col BETWEEN ? AND ? "
            "AND t.row BETWEEN ? AND ?",
            (
                descendant_depth,
                column * scale, (column + 1) * scale - 1,
                row * scale, (row + 1) * scale - 1,
            ),
        ).fetchall()
        if not rows:
            continue

        # Terrain masks have shared edge samples (normally 65x65). Project
        # every positive descendant sample to its nearest parent sample with
        # OR/max semantics, preserving narrow cartographic strokes.
        output_width = int(rows[0][2])
        output_height = int(rows[0][3])
        output = np.zeros((output_height, output_width), dtype=bool)
        for child_column, child_row, width, height, blob in rows:
            width, height = int(width), int(height)
            values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
            if values.size != width * height:
                continue
            child = values.reshape((height, width)).astype(bool)
            child_y, child_x = np.nonzero(child)
            if child_x.size == 0:
                continue
            offset_x = int(child_column) - column * scale
            offset_y = int(child_row) - row * scale
            parent_x = np.rint(
                (offset_x * (width - 1) + child_x) * (output_width - 1)
                / (scale * (width - 1))
            ).astype(np.intp)
            parent_y = np.rint(
                (offset_y * (height - 1) + child_y) * (output_height - 1)
                / (scale * (height - 1))
            ).astype(np.intp)
            output[parent_y, parent_x] = True
        return output if np.any(output) else None
    return None


def _read_mask(db, table: str, tile_id: str) -> np.ndarray | None:
    row = db.execute(
        f"SELECT width, height, mask FROM {table} WHERE tile_id = ?",
        (tile_id,),
    ).fetchone()
    if row is None:
        return None
    width, height, blob = int(row[0]), int(row[1]), row[2]
    values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
    if values.size != width * height:
        raise ValueError(
            f"coastline mask for {tile_id} has {values.size} values; "
            f"expected {width * height}"
        )
    return values.reshape((height, width)).astype(bool)


def _mask_rows_at_depth(db, table: str, depth: int):
    rows = db.execute(
        f"SELECT m.tile_id, t.col, t.row, m.width, m.height, m.mask, "
        f"t.heightmap "
        f"FROM {table} m JOIN tiles t ON t.tile_id = m.tile_id "
        "WHERE t.depth = ?",
        (depth,),
    ).fetchall()
    result = {}
    for tile_id, col, row, width, height, blob, heightmap_blob in rows:
        values = np.frombuffer(zlib.decompress(blob), dtype=np.uint8)
        if values.size != int(width) * int(height):
            continue
        result[(int(col), int(row))] = (
            tile_id,
            values.reshape((int(height), int(width))).astype(bool),
            heightmap_blob,
        )
    return result


def _connectivity_signature(db, depth: int) -> tuple:
    mask_signature = tuple(
        value
        for table in ("coastline_masks", "hydrography_masks")
        for value in db.execute(
            f"SELECT COUNT(*), COALESCE(MAX(m.updated_at), '') "
            f"FROM {table} m JOIN tiles t ON t.tile_id = m.tile_id "
            "WHERE t.depth = ?",
            (depth,),
        ).fetchone()
    )
    terrain_signature = db.execute(
        "SELECT COUNT(*), COALESCE(MAX(t.updated_at), '') "
        "FROM hydrography_masks m JOIN tiles t ON t.tile_id = m.tile_id "
        "WHERE t.depth = ?",
        (depth,),
    ).fetchone()
    return mask_signature + tuple(terrain_signature)


def _database_cache_key(db, depth: int) -> tuple[str, int]:
    path = db.execute("PRAGMA database_list").fetchone()[2]
    return (path or f":memory:{id(db)}", depth)


def _build_connected_hydrography(db, depth: int) -> dict[str, np.ndarray]:
    """Flood Åbent Land components from trusted GTK50 tidal-sea edges.

    Connectivity is four-neighbour and crosses only matching samples on exact
    shared tile edges. Narrow dashed creek strokes therefore cannot bridge
    gaps or carry the sea flood uphill.
    """
    from scipy.ndimage import label

    hydro = _mask_rows_at_depth(db, "hydrography_masks", depth)
    coast = _mask_rows_at_depth(db, "coastline_masks", depth)
    structure = np.asarray([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
    labeled = {}
    component_count = 0
    for address, (tile_id, mask, _) in hydro.items():
        labels, count = cast(
            tuple[np.ndarray, int], label(mask, structure=structure),
        )
        labeled[address] = (tile_id, mask, labels, count, component_count)
        component_count += count
    if component_count == 0:
        return {
            tile_id: np.zeros_like(mask)
            for tile_id, mask, _ in hydro.values()
        }

    parent = np.arange(component_count, dtype=np.int32)
    seeded = np.zeros(component_count, dtype=bool)

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = int(parent[value])
        return value

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    def component_ids(entry, values):
        labels, base = entry[2], entry[4]
        local = np.unique(labels[values])
        return base + local[local > 0] - 1

    for (col, row), entry in labeled.items():
        _, mask, labels, _, base = entry
        heightmap_blob = hydro[(col, row)][2]
        if heightmap_blob is not None:
            heightmap = np.frombuffer(
                zlib.decompress(heightmap_blob), dtype=np.float32,
            )
            if heightmap.size == mask.size:
                heightmap = heightmap.reshape(mask.shape)
                finite = heightmap[np.isfinite(heightmap)]
                # Only an entirely sea-level tile seeds the WMS component.
                # A low creek/lake sample inside otherwise elevated terrain
                # cannot independently grant itself tidal authority.
                if finite.size and float(np.max(finite)) <= SEA_SEED_MAX_ELEV_M:
                    for node in component_ids(entry, mask):
                        seeded[int(node)] = True

        same_coast = coast.get((col, row))
        if same_coast is not None and same_coast[1].shape == mask.shape:
            for node in component_ids(entry, mask & same_coast[1]):
                seeded[int(node)] = True

        for dc, dr, own_edge, other_edge in (
            (1, 0, (slice(None), -1), (slice(None), 0)),
            (0, 1, (-1, slice(None)), (0, slice(None))),
        ):
            neighbor = labeled.get((col + dc, row + dr))
            if neighbor is not None:
                touching = mask[own_edge] & neighbor[1][other_edge]
                own_labels = labels[own_edge][touching]
                neighbor_labels = neighbor[2][other_edge][touching]
                for own_label, neighbor_label in zip(own_labels, neighbor_labels):
                    union(base + int(own_label) - 1, neighbor[4] + int(neighbor_label) - 1)

        for dc, dr, own_edge, coast_edge in (
            (-1, 0, (slice(None), 0), (slice(None), -1)),
            (1, 0, (slice(None), -1), (slice(None), 0)),
            (0, -1, (0, slice(None)), (-1, slice(None))),
            (0, 1, (-1, slice(None)), (0, slice(None))),
        ):
            neighbor_coast = coast.get((col + dc, row + dr))
            if neighbor_coast is None:
                continue
            coast_mask = neighbor_coast[1]
            if mask[own_edge].shape != coast_mask[coast_edge].shape:
                continue
            touching = mask[own_edge] & coast_mask[coast_edge]
            for own_label in np.unique(labels[own_edge][touching]):
                if own_label > 0:
                    seeded[base + int(own_label) - 1] = True

    seed_roots = {find(int(index)) for index in np.flatnonzero(seeded)}
    result = {}
    for tile_id, mask, labels, count, base in labeled.values():
        accepted = [
            local_label for local_label in range(1, count + 1)
            if find(base + local_label - 1) in seed_roots
        ]
        result[tile_id] = np.isin(labels, accepted) if accepted else np.zeros_like(mask)
    return result


def _connected_hydrography_for_tile(db, tile_id: str) -> np.ndarray | None:
    row = db.execute(
        "SELECT depth FROM tiles WHERE tile_id = ?", (tile_id,)
    ).fetchone()
    if row is None:
        return None
    depth = int(row[0])
    key = _database_cache_key(db, depth)
    signature = _connectivity_signature(db, depth)
    with _connected_hydro_cache_lock:
        cached = _connected_hydro_cache.get(key)
    if cached is None or cached[0] != signature:
        masks = _build_connected_hydrography(db, depth)
        with _connected_hydro_cache_lock:
            _connected_hydro_cache[key] = (signature, masks)
    else:
        masks = cached[1]
    return masks.get(tile_id)


def cache_official_water_mask(db, tile_id: str, bbox=None, resolution=65):
    if bbox is None:
        row = db.execute(
            "SELECT x_min, y_min, x_max, y_max FROM tiles WHERE tile_id = ?",
            (tile_id,),
        ).fetchone()
        if row is None:
            return None
        bbox = tuple(float(value) for value in row)
    water = None
    if os.environ.get("COASTLINE_VECTOR", "1") != "0":
        from gtk50_vector import VECTOR_SOURCE, VECTOR_VERSION, vector_water_mask

        water = vector_water_mask(bbox, resolution)
        if water is not None:
            write_water_mask(db, tile_id, water, VECTOR_SOURCE, VECTOR_VERSION)
            return water
    water = fetch_official_water_mask(bbox, resolution)
    if water is not None:
        write_hydrography_mask(db, tile_id, water)
    # The rendered map also contains lakes and watercourses. Retain it as raw
    # hydrography; only a separately proven flood-connected component can
    # later participate in the effective tidal mask.
    return None


def ensure_water_floor_version(db) -> None:
    """Flush every cached seam once when the derived water geometry changes.

    Seams are baked from effective heightmaps, so a change to how the water
    floor is derived staleness-poisons the whole seam cache even though no
    mask row was rewritten.
    """
    row = db.execute(
        "SELECT value FROM metadata WHERE key = 'water_floor_version'"
    ).fetchone()
    if row is not None and int(row[0]) == WATER_FLOOR_VERSION:
        return
    deleted = db.execute("DELETE FROM terrain_seam_cache").rowcount
    db.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
        ("water_floor_version", str(WATER_FLOOR_VERSION)),
    )
    db.commit()
    log_coast.info(
        f"[coastline] water floor version -> {WATER_FLOOR_VERSION}, "
        f"flushed {deleted} cached seams"
    )


def effective_heightmap(db, tile_id: str, raw_heightmap):
    """Apply water fallback and real bathymetry without changing stored DEMs.

    Recomputed on every read. Caching the repaired arrays (or the
    decompressed masks) is a possible perf win, deliberately deferred
    until the vector mask pipeline is proven end-to-end.
    """
    water = read_water_mask(db, tile_id)
    if raw_heightmap is None:
        if water is not None and np.all(water):
            result = np.full(
                water.shape, -WATER_FLOOR_DROP_M, dtype=np.float32,
            )
        else:
            return None
    elif water is None:
        # No vector mask for this tile -- but bathymetry is keyed on position,
        # not on mask coverage, and read_bathymetry resamples from whatever
        # ancestor has a row. Returning here skipped it entirely, so every
        # tile without a mask rendered its stored water plate at -5 m while
        # the carved level beneath it sat hundreds of metres lower. At depth
        # 13 only 144 of 3959 tiles carry a mask, which is why that level came
        # out as a field of rectangular mesas while depth 12 looked correct.
        #
        # Fall back to the DEM's own water convention: a sample at or below
        # sea level is water. That is the same convention the stored plate is
        # written with, so it recovers exactly the samples bathymetry is
        # entitled to replace and touches nothing above the waterline.
        result = np.array(raw_heightmap, dtype=np.float32, copy=True)
        water = result <= 0.0
        if not np.any(water):
            return raw_heightmap
    else:
        result = apply_water_mask(raw_heightmap, water)
    from bathymetry import read_bathymetry

    bathymetry = read_bathymetry(db, tile_id, result.shape)
    bathymetry_vertices = 0
    if bathymetry is not None:
        if bathymetry.shape != result.shape:
            raise ValueError(
                f"bathymetry shape {bathymetry.shape} does not match DEM "
                f"{result.shape} for {tile_id}"
            )
        # The supplied depth-8 rasters retain positive land elevations around
        # their carved water. A finer official shoreline can classify a sample
        # as water where that coarse raster still says land; positive values
        # are therefore non-applicable bathymetry and retain the -5 m fallback.
        bathymetry_mask = water & np.isfinite(bathymetry) & (bathymetry < 0.0)
        bathymetry_vertices = int(np.sum(bathymetry_mask))
        result[bathymetry_mask] = bathymetry[bathymetry_mask]
    with _logged_effective_tiles_lock:
        should_log = tile_id not in _logged_effective_tiles
        if should_log:
            _logged_effective_tiles.add(tile_id)
    if should_log:
        raw = (
            np.asarray(raw_heightmap, dtype=np.float32)
            if raw_heightmap is not None
            else np.full(water.shape, np.nan, dtype=np.float32)
        )
        finite_water = water & np.isfinite(raw)
        clamped_water = finite_water & (raw != -WATER_FLOOR_DROP_M)
        source_row = db.execute(
            "SELECT source FROM coastline_masks WHERE tile_id = ?", (tile_id,)
        ).fetchone()
        mask_source = source_row[0] if source_row is not None else "unknown"
        raw_water_max = (
            float(np.max(raw[finite_water])) if np.any(finite_water) else float("nan")
        )
        log_coast.info(
            f"[coastline-apply] tile={tile_id} source={mask_source} "
            f"water_vertices={int(np.sum(water))} "
            f"clamped_vertices={int(np.sum(clamped_water))} "
            f"bathymetry_vertices={bathymetry_vertices} "
            f"raw_water_max_m={raw_water_max:.3f}"
        )
    return result

"""Read-only map payload for bathymetry coverage and depth soundings."""

from __future__ import annotations

import numpy as np

from coords import to_stereo


# Use the finest producer rows for the overlay. Contract-depth footprints are
# about 10.5 km wide and visually overstate mapped water far onto adjacent
# land; depth 12 keeps the HUD map within one 659 m terrain tile.
MAP_COVERAGE_DEPTH = 12


def _bbox_intersects_circle(
    bbox: tuple[float, float, float, float],
    qx: float,
    qy: float,
    radius: float,
) -> bool:
    """Return whether an axis-aligned footprint touches the map radius."""
    x_min, y_min, x_max, y_max = bbox
    nearest_x = min(max(qx, x_min), x_max)
    nearest_y = min(max(qy, y_min), y_max)
    return (nearest_x - qx) ** 2 + (nearest_y - qy) ** 2 <= radius ** 2


def query_bathymetry_map(
    db,
    qx: float,
    qy: float,
    max_range: float,
    *,
    ox: float,
    oy: float,
) -> dict:
    """Return origin-relative mapped footprints and nearby sounding points."""
    radius = max(float(max_range), 0.0)
    bbox = (qx - radius, qy - radius, qx + radius, qy + radius)
    coverage_rows = db.execute(
        "SELECT b.tile_id, t.x_min, t.y_min, t.x_max, t.y_max, "
        "b.source, b.version, b.updated_at "
        "FROM bathymetry b JOIN tiles t ON t.tile_id = b.tile_id "
        "WHERE t.depth = ? AND t.x_max >= ? AND t.x_min <= ? "
        "AND t.y_max >= ? AND t.y_min <= ? "
        "ORDER BY b.tile_id",
        (MAP_COVERAGE_DEPTH, bbox[0], bbox[2], bbox[1], bbox[3]),
    ).fetchall()
    coverage = []
    for (
            tile_id,
            x_min,
            y_min,
            x_max,
            y_max,
            source,
            version,
            updated_at,
    ) in coverage_rows:
        absolute_bbox = (
            float(x_min),
            float(y_min),
            float(x_max),
            float(y_max),
        )
        if not _bbox_intersects_circle(absolute_bbox, qx, qy, radius):
            continue
        coverage.append(
            {
                "tileId": tile_id,
                "bbox": [
                    absolute_bbox[0] - ox,
                    absolute_bbox[1] - oy,
                    absolute_bbox[2] - ox,
                    absolute_bbox[3] - oy,
                ],
                "source": source,
                "version": int(version),
                "updatedAt": updated_at,
            }
        )

    sounding_rows = db.execute(
        "SELECT source_url, record_id, latitude, longitude, depth_m, depth_kind "
        "FROM soundings ORDER BY source_url, record_id"
    ).fetchall()
    if sounding_rows:
        xs, ys = to_stereo(
            np.asarray([row[2] for row in sounding_rows], dtype=np.float64),
            np.asarray([row[3] for row in sounding_rows], dtype=np.float64),
        )
    else:
        xs, ys = np.asarray([]), np.asarray([])
    soundings = []
    for row, x, y in zip(sounding_rows, xs, ys):
        x, y = float(x), float(y)
        if (x - qx) ** 2 + (y - qy) ** 2 > radius ** 2:
            continue
        soundings.append(
            {
                "id": f"{row[0]}|{row[1]}",
                "x": x - ox,
                "y": y - oy,
                "depthM": float(row[4]),
                "kind": row[5],
            }
        )

    return {
        "coverage": coverage,
        "soundings": soundings,
        "coverageCount": len(coverage),
        "soundingCount": len(soundings),
        "qx": qx,
        "qy": qy,
    }

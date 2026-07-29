"""Persist generated-bathymetry health beside sourced depth evidence."""

from __future__ import annotations

import datetime
from dataclasses import dataclass
import math

import numpy as np

from bathymetry import _decode_row, _sample_point
from terrain_config import GREENLAND_BBOX
from tile_address import format_tile_id, inset_tile_corners


HEALTH_WHITE = "white"
HEALTH_YELLOW = "yellow"
HEALTH_RED = "red"
CORNER_NAMES = ("sw", "se", "nw", "ne")


@dataclass(frozen=True)
class ModelSample:
    depth_m: float
    tile_id: str
    source: str
    version: int
    updated_at: str


def health_for_error(error_m: float, evidence_depth_m: float) -> str:
    """Map evidence-aware error to the deliberately small UI vocabulary."""
    error = max(float(error_m), 0.0)
    evidence_depth = max(float(evidence_depth_m), 0.0)
    yellow_at = max(10.0, evidence_depth * 0.10)
    red_at = max(30.0, evidence_depth * 0.25)
    if error >= red_at:
        return HEALTH_RED
    if error >= yellow_at:
        return HEALTH_YELLOW
    return HEALTH_WHITE


def comparison_error(
    modeled_depth_m: float,
    evidence_depth_m: float,
    depth_kind: str,
) -> tuple[float, float]:
    """Return signed model delta and the evidence-aware health penalty."""
    delta = float(modeled_depth_m) - float(evidence_depth_m)
    if depth_kind == "at_least":
        # A CTD endpoint only proves the bottom is at least this deep.
        error = max(0.0, -delta)
    else:
        error = abs(delta)
    return delta, error


def _point_tile_id(depth: int, x: float, y: float) -> str | None:
    x_min, y_min, x_max, y_max = GREENLAND_BBOX
    if not (x_min <= x <= x_max and y_min <= y <= y_max):
        return None
    scale = 1 << depth
    column = min(
        scale - 1,
        max(0, int((x - x_min) / (x_max - x_min) * scale)),
    )
    row = min(
        scale - 1,
        max(0, int((y - y_min) / (y_max - y_min) * scale)),
    )
    return format_tile_id(depth, column, row)


def sample_generated_bathymetry(
    db,
    x: float,
    y: float,
    *,
    max_depth: int | None = None,
) -> ModelSample | None:
    """Sample the finest generated raster covering one stereo coordinate."""
    if max_depth is None:
        row = db.execute(
            "SELECT MAX(t.depth) FROM bathymetry b "
            "JOIN tiles t ON t.tile_id = b.tile_id"
        ).fetchone()
        if row is None or row[0] is None:
            return None
        max_depth = int(row[0])

    candidate_ids = [
        tile_id
        for depth in range(int(max_depth), -1, -1)
        if (tile_id := _point_tile_id(depth, x, y)) is not None
    ]
    if not candidate_ids:
        return None
    placeholders = ",".join("?" for _ in candidate_ids)
    rows = {
        row[0]: row[1:]
        for row in db.execute(
            "SELECT b.tile_id, b.heightmap, b.source, b.version, "
            "b.updated_at, t.x_min, t.y_min, t.x_max, t.y_max "
            "FROM bathymetry b JOIN tiles t ON t.tile_id = b.tile_id "
            f"WHERE b.tile_id IN ({placeholders})",
            candidate_ids,
        )
    }
    for tile_id in candidate_ids:
        row = rows.get(tile_id)
        if row is None:
            continue
        blob, source, version, updated_at, x0, y0, x1, y1 = row
        values = _decode_row(tile_id, blob)
        column = (float(x) - float(x0)) / (float(x1) - float(x0))
        sample_row = (float(y) - float(y0)) / (float(y1) - float(y0))
        elevation = _sample_point(
            values,
            sample_row * (values.shape[0] - 1),
            column * (values.shape[1] - 1),
        )
        if not np.isfinite(elevation):
            continue
        return ModelSample(
            depth_m=max(0.0, -float(elevation)),
            tile_id=tile_id,
            source=str(source),
            version=int(version),
            updated_at=str(updated_at),
        )
    return None


def _model_signature(
    samples: list[tuple[str, ModelSample | None]],
) -> str:
    """Return a stable signature for every model sample in one comparison."""
    return ";".join(
        (
            f"{name}=none"
            if sample is None
            else (
                f"{name}={sample.tile_id}|{sample.source}|{sample.version}|"
                f"{sample.updated_at}"
            )
        )
        for name, sample in samples
    )


def _common_model_metadata(
    models: list[ModelSample],
) -> tuple[str | None, str | None, int | None, str | None]:
    """Keep legacy scalar metadata when all matched samples share one model."""
    if not models:
        return None, None, None, None
    tiles = {model.tile_id for model in models}
    sources = {model.source for model in models}
    versions = {model.version for model in models}
    updated = {model.updated_at for model in models}
    return (
        next(iter(tiles)) if len(tiles) == 1 else None,
        next(iter(sources)) if len(sources) == 1 else "mixed",
        next(iter(versions)) if len(versions) == 1 else None,
        next(iter(updated)) if len(updated) == 1 else max(updated),
    )


def _same_optional_number(left, right) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return math.isclose(
        float(left),
        float(right),
        rel_tol=1e-12,
        abs_tol=1e-9,
    )


def refresh_sounding_health(
    db,
    *,
    bounds: tuple[float, float, float, float] | None = None,
    tile_id: str | None = None,
    source_url: str | None = None,
    force: bool = False,
) -> int:
    """Refresh missing/stale comparisons and return the number written."""
    if tile_id is not None:
        tile = db.execute(
            "SELECT x_min, y_min, x_max, y_max FROM tiles WHERE tile_id = ?",
            (tile_id,),
        ).fetchone()
        if tile is None:
            return 0
        bounds = tuple(float(value) for value in tile)

    clauses = ["evidence_status = 'accepted'"]
    params: list[object] = []
    if bounds is not None:
        clauses.extend(
            [
                "stereo_x >= ?",
                "stereo_x <= ?",
                "stereo_y >= ?",
                "stereo_y <= ?",
            ]
        )
        params.extend([bounds[0], bounds[2], bounds[1], bounds[3]])
    if source_url is not None:
        clauses.append("source_url = ?")
        params.append(source_url)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    soundings = db.execute(
        "SELECT source_url, record_id, stereo_x, stereo_y, depth_m, "
        "depth_kind, comparison_method, evidence_sw_m, evidence_se_m, "
        "evidence_nw_m, evidence_ne_m, modeled_depth_m, model_delta_m, "
        "model_error_m, model_health, modeled_sw_m, modeled_se_m, "
        "modeled_nw_m, modeled_ne_m, model_sample_count, model_signature, "
        "compared_at "
        f"FROM soundings {where}",
        params,
    ).fetchall()
    if not soundings:
        return 0

    max_depth_row = db.execute(
        "SELECT MAX(t.depth) FROM bathymetry b "
        "JOIN tiles t ON t.tile_id = b.tile_id"
    ).fetchone()
    max_depth = (
        int(max_depth_row[0])
        if max_depth_row and max_depth_row[0] is not None
        else None
    )
    compared_at = datetime.datetime.now(
        datetime.timezone.utc
    ).isoformat()
    updates = []
    for row in soundings:
        (
            sounding_source,
            record_id,
            x,
            y,
            evidence_depth,
            depth_kind,
            comparison_method,
            evidence_sw,
            evidence_se,
            evidence_nw,
            evidence_ne,
            stored_modeled_depth,
            stored_delta,
            stored_error,
            stored_health,
            stored_modeled_sw,
            stored_modeled_se,
            stored_modeled_nw,
            stored_modeled_ne,
            stored_sample_count,
            stored_signature,
            stored_compared_at,
        ) = row
        modeled_corners: list[float | None] = [None, None, None, None]
        if comparison_method == "corner_rms":
            evidence_corners = (
                evidence_sw,
                evidence_se,
                evidence_nw,
                evidence_ne,
            )
            try:
                corner_points = inset_tile_corners(
                    record_id, GREENLAND_BBOX
                )
            except ValueError:
                corner_points = ()
            named_samples = []
            pairs = []
            models = []
            for index, (name, evidence_corner) in enumerate(
                zip(CORNER_NAMES, evidence_corners)
            ):
                if evidence_corner is None or index >= len(corner_points):
                    continue
                corner_x, corner_y = corner_points[index]
                model = (
                    sample_generated_bathymetry(
                        db,
                        corner_x,
                        corner_y,
                        max_depth=max_depth,
                    )
                    if max_depth is not None
                    else None
                )
                named_samples.append((name, model))
                if model is None:
                    continue
                modeled_corners[index] = model.depth_m
                delta, penalty = comparison_error(
                    model.depth_m,
                    float(evidence_corner),
                    str(depth_kind),
                )
                pairs.append((float(evidence_corner), model.depth_m, delta, penalty))
                models.append(model)
        else:
            model = (
                sample_generated_bathymetry(
                    db, float(x), float(y), max_depth=max_depth
                )
                if x is not None and y is not None and max_depth is not None
                else None
            )
            named_samples = [("point", model)]
            models = [model] if model is not None else []
            pairs = []
            if model is not None:
                delta, penalty = comparison_error(
                    model.depth_m, float(evidence_depth), str(depth_kind)
                )
                pairs.append(
                    (float(evidence_depth), model.depth_m, delta, penalty)
                )

        signature = _model_signature(named_samples)
        model_tile, model_source, model_version, model_updated_at = (
            _common_model_metadata(models)
        )
        if pairs:
            evidence_reference = float(np.mean([pair[0] for pair in pairs]))
            modeled_depth = float(np.mean([pair[1] for pair in pairs]))
            mean_delta = float(np.mean([pair[2] for pair in pairs]))
            rms_error = math.sqrt(
                float(np.mean([pair[3] ** 2 for pair in pairs]))
            )
            health = health_for_error(rms_error, evidence_reference)
        else:
            modeled_depth = None
            mean_delta = None
            rms_error = None
            health = HEALTH_WHITE
        expected_numbers = (
            modeled_depth,
            mean_delta,
            rms_error,
            *modeled_corners,
        )
        stored_numbers = (
            stored_modeled_depth,
            stored_delta,
            stored_error,
            stored_modeled_sw,
            stored_modeled_se,
            stored_modeled_nw,
            stored_modeled_ne,
        )
        if (
            not force
            and stored_compared_at
            and stored_signature == signature
            and stored_health == health
            and int(stored_sample_count or 0) == len(pairs)
            and all(
                _same_optional_number(stored, expected)
                for stored, expected in zip(
                    stored_numbers, expected_numbers
                )
            )
        ):
            continue
        updates.append(
            (
                modeled_depth,
                mean_delta,
                rms_error,
                health,
                model_tile,
                model_source,
                model_version,
                model_updated_at,
                *modeled_corners,
                len(pairs),
                signature,
                compared_at,
                sounding_source,
                record_id,
            )
        )

    db.executemany(
        "UPDATE soundings SET modeled_depth_m = ?, model_delta_m = ?, "
        "model_error_m = ?, model_health = ?, model_tile_id = ?, "
        "model_source = ?, model_version = ?, model_updated_at = ?, "
        "modeled_sw_m = ?, modeled_se_m = ?, modeled_nw_m = ?, "
        "modeled_ne_m = ?, model_sample_count = ?, model_signature = ?, "
        "comparison_revision = comparison_revision + 1, "
        "compared_at = ? WHERE source_url = ? AND record_id = ?",
        updates,
    )
    return len(updates)

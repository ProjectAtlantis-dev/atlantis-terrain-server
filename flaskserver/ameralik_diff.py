"""Compare persisted Ameralik TIFF health between two terrain databases."""

from __future__ import annotations

import argparse
import collections
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import sqlite3
from typing import Iterable


PANGAEA_992416 = "https://doi.org/10.1594/PANGAEA.992416"


@dataclass(frozen=True)
class EvidenceResult:
    tile_id: str
    root_id: str
    error_m: float
    bias_m: float
    health: str


@dataclass(frozen=True)
class Metrics:
    count: int
    rms_m: float
    bias_m: float
    mean_abs_tile_bias_m: float
    white: int
    yellow: int
    red: int


def root_id(tile_id: str) -> str | None:
    try:
        depth, column, row = map(int, tile_id.split("-"))
    except (TypeError, ValueError):
        return None
    if depth != 12:
        return None
    return f"8-{column >> 4}-{row >> 4}"


def load_results(
    database: str | Path,
    *,
    source_url: str = PANGAEA_992416,
) -> dict[str, EvidenceResult]:
    connection = sqlite3.connect(f"file:{Path(database)}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT record_id, model_error_m, model_delta_m, model_health "
            "FROM soundings WHERE source_url = ? "
            "AND evidence_format = 'raster' "
            "AND evidence_status = 'accepted' "
            "AND model_error_m IS NOT NULL "
            "AND model_delta_m IS NOT NULL",
            (source_url,),
        ).fetchall()
    finally:
        connection.close()

    results: dict[str, EvidenceResult] = {}
    for tile_id, error, bias, health in rows:
        parent = root_id(tile_id)
        if parent is None:
            continue
        results[str(tile_id)] = EvidenceResult(
            tile_id=str(tile_id),
            root_id=parent,
            error_m=float(error),
            bias_m=float(bias),
            health=str(health),
        )
    return results


def metrics(rows: Iterable[EvidenceResult]) -> Metrics:
    values = list(rows)
    if not values:
        return Metrics(0, math.nan, math.nan, math.nan, 0, 0, 0)
    colors = collections.Counter(row.health for row in values)
    return Metrics(
        count=len(values),
        rms_m=math.sqrt(
            sum(row.error_m * row.error_m for row in values) / len(values)
        ),
        bias_m=sum(row.bias_m for row in values) / len(values),
        mean_abs_tile_bias_m=(
            sum(abs(row.bias_m) for row in values) / len(values)
        ),
        white=colors["white"],
        yellow=colors["yellow"],
        red=colors["red"],
    )


def compare(
    baseline: dict[str, EvidenceResult],
    candidate: dict[str, EvidenceResult],
) -> dict[str, object]:
    common_ids = sorted(set(baseline) & set(candidate))
    before = [baseline[tile_id] for tile_id in common_ids]
    after = [candidate[tile_id] for tile_id in common_ids]
    before_metrics = metrics(before)
    after_metrics = metrics(after)
    roots: dict[str, object] = {}
    root_names = sorted(
        {row.root_id for row in before} | {row.root_id for row in after},
        key=lambda value: tuple(map(int, value.split("-"))),
    )
    for name in root_names:
        root_before = metrics(row for row in before if row.root_id == name)
        root_after = metrics(row for row in after if row.root_id == name)
        roots[name] = {
            "baseline": asdict(root_before),
            "candidate": asdict(root_after),
            "rms_change_m": root_after.rms_m - root_before.rms_m,
        }

    rms_reduction = before_metrics.rms_m - after_metrics.rms_m
    rms_reduction_percent = (
        rms_reduction / before_metrics.rms_m * 100.0
        if before_metrics.rms_m
        else math.nan
    )
    mse_reduction_percent = (
        (
            before_metrics.rms_m**2 - after_metrics.rms_m**2
        )
        / before_metrics.rms_m**2
        * 100.0
        if before_metrics.rms_m
        else math.nan
    )
    return {
        "common_count": len(common_ids),
        "baseline_only_count": len(set(baseline) - set(candidate)),
        "candidate_only_count": len(set(candidate) - set(baseline)),
        "baseline": asdict(before_metrics),
        "candidate": asdict(after_metrics),
        "rms_reduction_m": rms_reduction,
        "rms_reduction_percent": rms_reduction_percent,
        "mse_reduction_percent": mse_reduction_percent,
        "roots": roots,
    }


def metric_line(label: str, values: dict[str, object]) -> str:
    return (
        f"{label:10s} n={values['count']:4d} "
        f"rms={values['rms_m']:7.2f} "
        f"bias={values['bias_m']:+7.2f} "
        f"mean|tile bias|={values['mean_abs_tile_bias_m']:7.2f} "
        f"W/Y/R={values['white']}/{values['yellow']}/{values['red']}"
    )


def format_report(result: dict[str, object]) -> str:
    baseline = result["baseline"]
    candidate = result["candidate"]
    assert isinstance(baseline, dict)
    assert isinstance(candidate, dict)
    lines = [
        "Ameralik exact PANGAEA TIFF comparison (paired D12 tiles)",
        metric_line("baseline", baseline),
        metric_line("candidate", candidate),
        (
            f"change     rms={result['rms_reduction_m']:+7.2f} m reduction "
            f"({result['rms_reduction_percent']:+6.2f}%), "
            f"squared-error reduction={result['mse_reduction_percent']:+6.2f}%"
        ),
        (
            "coverage   "
            f"common={result['common_count']} "
            f"baseline-only={result['baseline_only_count']} "
            f"candidate-only={result['candidate_only_count']}"
        ),
        "",
        "Per-root paired changes",
    ]
    roots = result["roots"]
    assert isinstance(roots, dict)
    for name, root_value in roots.items():
        assert isinstance(root_value, dict)
        root_before = root_value["baseline"]
        root_after = root_value["candidate"]
        assert isinstance(root_before, dict)
        assert isinstance(root_after, dict)
        lines.append(
            f"{name:11s} n={root_before['count']:3d} "
            f"rms {root_before['rms_m']:6.1f}->{root_after['rms_m']:6.1f} "
            f"({root_value['rms_change_m']:+6.1f}) "
            f"bias {root_before['bias_m']:+7.1f}->{root_after['bias_m']:+7.1f} "
            f"W/Y/R "
            f"{root_before['white']}/{root_before['yellow']}/{root_before['red']}"
            "->"
            f"{root_after['white']}/{root_after['yellow']}/{root_after['red']}"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline_db")
    parser.add_argument("candidate_db")
    parser.add_argument("--json-output")
    args = parser.parse_args()

    result = compare(
        load_results(args.baseline_db),
        load_results(args.candidate_db),
    )
    result["baseline_database"] = str(Path(args.baseline_db).resolve())
    result["candidate_database"] = str(Path(args.candidate_db).resolve())
    print(format_report(result))
    if args.json_output:
        output = Path(args.json_output)
        output.write_text(
            json.dumps(result, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()

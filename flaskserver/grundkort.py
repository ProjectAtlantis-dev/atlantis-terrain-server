"""Self-healing Asiaq Teknisk Grundkort ingestion.

Settlement zips (``*_TekniskGrundkort_SHP.zip`` from
kortforsyning.asiaq.gl) live in ``grundkort/`` (gitignored). At server
startup a background thread ingests any settlement whose buildings/roads
rows are missing, so a flushed terrain.db repopulates itself the same
way tiles and masks do — no manual re-ingest.

Fresh-DB ordering is handled by deferral: buildings ingested before the
area's heightmaps exist get ``ground_sampled = 0`` (roof-derived ground
estimate), and ``/api/buildings`` re-samples them from real heightmaps
as those stream in.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from pathlib import Path

from colored_log import get_logger

log = get_logger("terrain.grundkort")

ZIP_DIR = Path(__file__).resolve().parent / "grundkort"
DB_PATH = Path(__file__).resolve().parent / "terrain.db"


def _settlement_of(name: str) -> str | None:
    match = re.match(r"(\d{4}[A-Z]{3})", name)
    return match.group(1) if match else None


def _ensure_schema(db) -> None:
    from ingest_buildings import BUILDINGS_SCHEMA
    from ingest_roads import ROADS_SCHEMA

    db.executescript(BUILDINGS_SCHEMA)
    db.executescript(ROADS_SCHEMA)
    columns = {row[1] for row in db.execute("PRAGMA table_info(buildings)")}
    if "ground_sampled" not in columns:
        db.execute(
            "ALTER TABLE buildings "
            "ADD COLUMN ground_sampled INTEGER NOT NULL DEFAULT 1"
        )
    db.commit()


def ensure_grundkort(db_path: Path = DB_PATH) -> None:
    """Ingest every settlement zip whose rows are missing. Idempotent."""
    ZIP_DIR.mkdir(exist_ok=True)
    zips = sorted(ZIP_DIR.glob("*.zip"))
    db = sqlite3.connect(str(db_path))
    try:
        _ensure_schema(db)
        for zip_path in zips:
            settlement = _settlement_of(zip_path.name)
            if settlement is None:
                log.warning(f"[grundkort] cannot infer settlement from {zip_path.name}, skipping")
                continue
            missing_buildings = not db.execute(
                "SELECT 1 FROM buildings WHERE settlement = ? LIMIT 1", (settlement,)
            ).fetchone()
            missing_roads = not db.execute(
                "SELECT 1 FROM roads WHERE settlement = ? LIMIT 1", (settlement,)
            ).fetchone()
            if missing_buildings:
                import ingest_buildings

                log.info(f"[grundkort] {settlement}: buildings missing, ingesting {zip_path.name}")
                ingest_buildings.ingest(zip_path, db_path)
            if missing_roads:
                import ingest_roads

                log.info(f"[grundkort] {settlement}: roads missing, ingesting {zip_path.name}")
                ingest_roads.ingest(zip_path, db_path)
    finally:
        db.close()
    if not zips:
        log.info("[grundkort] no settlement zips in grundkort/ — buildings/roads stay empty")


def ensure_grundkort_async() -> None:
    def _run() -> None:
        try:
            ensure_grundkort()
        except Exception as exc:
            log.error(f"[grundkort] startup ingest failed: {type(exc).__name__}: {exc}")

    threading.Thread(target=_run, daemon=True).start()


def repair_unsampled_ground(db, qx: float, qy: float, max_range: float) -> int:
    """Re-sample estimated building grounds from now-cached heightmaps."""
    try:
        rows = db.execute(
            "SELECT building_id, cx, cy, ring FROM buildings "
            "WHERE ground_sampled = 0 "
            "AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ?",
            (qx - max_range, qx + max_range, qy - max_range, qy + max_range),
        ).fetchall()
    except sqlite3.OperationalError:
        return 0  # schema not ensured yet
    if not rows:
        return 0
    from ingest_buildings import GroundSampler

    sampler = GroundSampler(db)
    if not sampler.tiles:
        return 0
    fixed = 0
    for building_id, cx, cy, ring_json in rows:
        ground = sampler.sample(cx, cy)
        if ground is None:
            continue
        roof_min = min(z for _, _, z in json.loads(ring_json))
        db.execute(
            "UPDATE buildings SET ground_z = ?, ground_sampled = 1 "
            "WHERE building_id = ?",
            (round(min(ground, roof_min - 0.5), 2), building_id),
        )
        fixed += 1
    if fixed:
        db.commit()
        log.info(f"[grundkort] re-sampled ground for {fixed} buildings from heightmaps")
    return fixed

"""Globally discard derived terrain data while retaining every origin.

This is a deterministic rebuild switch, not a regional cache-management tool.
After it runs, normal viewer demand must be able to reconstruct the database
from retained upstream facts regardless of the order in which those facts
originally arrived.

Retained origins include measured/downloaded DEMs, provider textures and
terminal provider no-coverage results, WMS hydrography, GTK50 GeoPackages on
disk, roads, buildings, and sounding evidence. Derived rasters, classifications,
cooks, presentation caches, bathymetry solves, seams, and sounding/model
comparisons are removed or reset.

Usage:
    ./venv/bin/python purge_derived.py          # preview
    ./venv/bin/python purge_derived.py --apply  # global derived-data reset
"""
from __future__ import annotations

import argparse
import datetime
import sqlite3
from pathlib import Path

from colored_log import get_logger

log_purge = get_logger("terrain.purge")
DB_PATH = Path(__file__).resolve().parent / "terrain.db"

# Payloads fetched or measured upstream. The unmasked states retain the same
# original payload while asking the normal pipeline to revisit classification.
ORIGIN_TILE_SOURCES = {
    "empty", "pending", "no_data",
    "arcticdem", "arcticdem_10m", "copernicus",
    "unmasked_arcticdem", "unmasked_arcticdem_10m",
    "unmasked_copernicus",
}

# Payloads reproducible from retained origins. Rows remain as skeletons because
# bbox/address/parent metadata is canonical input to later demand.
DERIVED_TILE_SOURCES = {
    "fractal_dem",  # pre-2026-07-23 spelling of cooked_dem
    "parent_resampled", "unmasked_parent_resampled",
    "cooked_dem", "official_coastline",
    "clobbered_arcticdem_10m", "clobbered_copernicus",
    "clobbered_parent_resampled", "clobbered_official_coastline",
}

# Actual provider imagery. Legacy provider generations are still origins even
# when the current runtime would upgrade them.
ORIGIN_TEXTURE_SOURCES = {
    "sentinel2", "dataforsyningen", "dataforsyningen_metatile",
    "dataforsyningen_metatile4", "dataforsyningen_metatile4h",
    "dataforsyningen_metatile4h2",
    # These rows retain a provider no-coverage result. Dropping them would force
    # another network request merely to rediscover the same absence.
    "ancestor_crop_nodata", "ocean_nodata",
}

DERIVED_TEXTURE_SOURCES = {
    "fractal_upscale",  # pre-2026-07-23 spelling of cooked_upscale
    "sentinel2_crop", "ancestor_crop", "ancestor_crop_ratelimit",
    "cooked_upscale",
}

# Entire tables whose rows are reproducible from retained origins. Optional
# tables are simply absent on older/fresh databases.
DERIVED_TABLES = (
    "coastline_masks",       # rasterized from local GTK50 GeoPackages
    "classifier_tiles",      # textures + masks
    "road_texture_bakes",    # provider texture + retained road vectors
    "cliff_graft_assets",    # provider texture + classifier/masks
    "terrain_seam_cache",    # effective heightmaps
    "bathymetry",            # sounding evidence + Glacier solve
    "water_purge_audit",     # audit of a particular derived cook generation
)


def _table_exists(db, table: str) -> bool:
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,),
    ).fetchone() is not None


def _source_counts(db, table: str) -> dict[str, int]:
    if not _table_exists(db, table):
        return {}
    return {
        str(source): int(count)
        for source, count in db.execute(
            f"SELECT source, COUNT(*) FROM {table} GROUP BY source"
        )
    }


def _validate_provenance(db) -> None:
    """Refuse to guess when a producer introduces an unclassified source."""
    classifications = (
        ("tiles", ORIGIN_TILE_SOURCES, DERIVED_TILE_SOURCES),
        ("textures", ORIGIN_TEXTURE_SOURCES, DERIVED_TEXTURE_SOURCES),
    )
    for table, origins, derived in classifications:
        unknown = set(_source_counts(db, table)) - origins - derived
        if unknown:
            raise RuntimeError(
                f"unclassified {table}.source values: {', '.join(sorted(unknown))}; "
                "classify each as origin or derived before purging"
            )


def _in_clause(values) -> tuple[str, tuple[str, ...]]:
    ordered = tuple(sorted(values))
    return ",".join("?" for _ in ordered), ordered


def _derived_sounding_where() -> str:
    return " OR ".join((
        "modeled_depth_m IS NOT NULL", "model_delta_m IS NOT NULL",
        "model_error_m IS NOT NULL", "model_tile_id IS NOT NULL",
        "model_source IS NOT NULL", "model_version IS NOT NULL",
        "model_updated_at IS NOT NULL", "compared_at IS NOT NULL",
        "modeled_sw_m IS NOT NULL", "modeled_se_m IS NOT NULL",
        "modeled_nw_m IS NOT NULL", "modeled_ne_m IS NOT NULL",
        "COALESCE(model_sample_count, 0) != 0", "model_signature IS NOT NULL",
        "COALESCE(model_health, 'white') != 'white'",
    ))


def plan_derived_purge(db) -> dict[str, int]:
    """Return exact global mutation counts without changing persistent data."""
    _validate_provenance(db)
    counts: dict[str, int] = {}

    tile_marks, tile_sources = _in_clause(DERIVED_TILE_SOURCES)
    counts["tiles (derived -> pending)"] = db.execute(
        f"SELECT COUNT(*) FROM tiles WHERE source IN ({tile_marks})",
        tile_sources,
    ).fetchone()[0]

    if _table_exists(db, "textures"):
        texture_marks, texture_sources = _in_clause(DERIVED_TEXTURE_SOURCES)
        counts["textures (derived)"] = db.execute(
            f"SELECT COUNT(*) FROM textures WHERE source IN ({texture_marks})",
            texture_sources,
        ).fetchone()[0]

    for table in DERIVED_TABLES:
        if _table_exists(db, table):
            counts[table] = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    if _table_exists(db, "soundings"):
        counts["soundings (model comparison reset)"] = db.execute(
            f"SELECT COUNT(*) FROM soundings WHERE {_derived_sounding_where()}"
        ).fetchone()[0]

    if _table_exists(db, "metadata"):
        counts["metadata (bathymetry failures)"] = db.execute(
            "SELECT COUNT(*) FROM metadata "
            "WHERE key LIKE 'bathymetry_demand_failure:%'"
        ).fetchone()[0]
    return counts


def apply_derived_purge(db) -> dict[str, int]:
    """Atomically reset every derivative and preserve every classified origin."""
    planned = plan_derived_purge(db)
    applied: dict[str, int] = {}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    tile_marks, tile_sources = _in_clause(DERIVED_TILE_SOURCES)
    applied["tiles (derived -> pending)"] = db.execute(
        "UPDATE tiles SET source='pending', heightmap=NULL, confidence_map=NULL, "
        "geometric_error=0, updated_at=?, dem_demanded_at=NULL, "
        "dem_requested_at=NULL, cog_requested_at=NULL "
        f"WHERE source IN ({tile_marks})",
        (now, *tile_sources),
    ).rowcount

    if _table_exists(db, "textures"):
        texture_marks, texture_sources = _in_clause(DERIVED_TEXTURE_SOURCES)
        applied["textures (derived)"] = db.execute(
            f"DELETE FROM textures WHERE source IN ({texture_marks})",
            texture_sources,
        ).rowcount

    # Tables are ordered so seam rows are counted/deleted before the bathymetry
    # delete trigger gets a chance to invalidate them too.
    for table in DERIVED_TABLES:
        if not _table_exists(db, table):
            continue
        applied[table] = db.execute(f"DELETE FROM {table}").rowcount

    if _table_exists(db, "soundings"):
        applied["soundings (model comparison reset)"] = db.execute(
            "UPDATE soundings SET modeled_depth_m=NULL, model_delta_m=NULL, "
            "model_error_m=NULL, model_health='white', model_tile_id=NULL, "
            "model_source=NULL, model_version=NULL, model_updated_at=NULL, "
            "compared_at=NULL, modeled_sw_m=NULL, modeled_se_m=NULL, "
            "modeled_nw_m=NULL, modeled_ne_m=NULL, model_sample_count=0, "
            "model_signature=NULL, comparison_revision=comparison_revision+1 "
            f"WHERE {_derived_sounding_where()}"
        ).rowcount

    if _table_exists(db, "metadata"):
        applied["metadata (bathymetry failures)"] = db.execute(
            "DELETE FROM metadata WHERE key LIKE 'bathymetry_demand_failure:%'"
        ).rowcount

    # A second run must be a no-op. Comparing the preview with actual row counts
    # also catches trigger or schema behavior that the plan did not account for.
    mismatches = {
        key: (planned.get(key, 0), applied.get(key, 0))
        for key in set(planned) | set(applied)
        if planned.get(key, 0) != applied.get(key, 0)
    }
    if mismatches:
        db.rollback()
        details = ", ".join(
            f"{key}: planned {want}, applied {got}"
            for key, (want, got) in sorted(mismatches.items())
        )
        raise RuntimeError(f"derived purge rolled back after count mismatch: {details}")
    db.commit()
    return applied


def _report(counts: dict[str, int], header: str) -> int:
    log_purge.info(f"[purge] {header}")
    total = 0
    for name, count in sorted(counts.items()):
        total += count
        log_purge.info(f"[purge]   {name:<38} {count}")
    log_purge.info(f"[purge]   {'TOTAL':<38} {total}")
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true",
        help="perform the global reset; without this the command is a preview",
    )
    args = parser.parse_args()

    db = sqlite3.connect(str(DB_PATH))
    try:
        counts = plan_derived_purge(db)
        _report(counts, "global derived-data reset")
        if not args.apply:
            log_purge.info("[purge] preview only — pass --apply to reset")
            return
        _report(apply_derived_purge(db), "global derived data reset")
        log_purge.info(
            "[purge] origins retained; normal demand will rebuild derivatives "
            "in whatever order their dependencies become available"
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()

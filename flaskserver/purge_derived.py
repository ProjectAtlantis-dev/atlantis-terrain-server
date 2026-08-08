"""Globally discard derived terrain data while retaining rebuild inputs.

This is a deterministic rebuild switch, not a regional cache-management tool.
After it runs, normal viewer demand must be able to reconstruct the database
from retained upstream facts regardless of the order in which those facts
originally arrived.

Retained inputs include measured/downloaded DEMs, provider textures, terminal
provider no-coverage cache rows, WMS hydrography, GTK50 GeoPackages on disk,
and sounding evidence. Asset vectors live in ``assets.db``. Derived rasters,
classifications, cooks, presentation caches, bathymetry solves, seams, and
sounding/model comparisons are removed or reset.

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

# Rows retained across the purge. Measured payloads are upstream; unmasked
# states retain that same payload while asking the pipeline to revisit
# classification. Empty/pending are scaffold state, and no_data is a durable
# upstream negative result rather than a payload.
RETAINED_TILE_SOURCES = {
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

# Rows retained across the purge. Provider generations contain origin imagery
# even when the current runtime would upgrade them. The no-coverage rows are
# intentionally hybrid: they retain an upstream negative result but their
# fallback image bytes are derived. See DATA_PROVENANCE_AUDIT.md.
RETAINED_TEXTURE_SOURCES = {
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
    "classifier_votes",      # D8-to-target semantic vote tallies
    "road_texture_bakes",    # provider texture + retained road vectors
    "cliff_graft_assets",    # provider texture + classifier/masks
    "terrain_seam_cache",    # effective heightmaps
    "bathymetry",            # sounding evidence + Glacier solve
    "water_purge_audit",     # audit of a particular derived cook generation
)

# Optional lineage storage from the retired terrain-manager experiment.  The
# tables mix origin and derived revisions, so they cannot be emptied wholesale:
# provider revisions are useful provenance, while crop/cook revisions describe
# payloads removed by this purge and must go with them.
ARTIFACT_LINEAGE_TABLES = (
    "terrain_artifact_revisions",
    "terrain_artifact_inputs",
    "terrain_artifact_current",
    "terrain_artifact_events",
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
        ("tiles", RETAINED_TILE_SOURCES, DERIVED_TILE_SOURCES),
        ("textures", RETAINED_TEXTURE_SOURCES, DERIVED_TEXTURE_SOURCES),
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


def _artifact_lineage_present(db) -> bool:
    present = {table for table in ARTIFACT_LINEAGE_TABLES if _table_exists(db, table)}
    if present and len(present) != len(ARTIFACT_LINEAGE_TABLES):
        missing = sorted(
            table for table in ARTIFACT_LINEAGE_TABLES if table not in present
        )
        raise RuntimeError(
            "incomplete terrain artifact lineage schema; missing: "
            + ", ".join(missing)
        )
    return bool(present)


def _derived_artifact_revision_ids(db) -> tuple[str, ...]:
    if not _artifact_lineage_present(db):
        return ()
    # source_label uses the same producer vocabulary as tiles.source and
    # textures.source.  Do not infer derivation from quality_class: the legacy
    # subsystem used "temporary" for crops, but future producers may use a
    # different quality taxonomy.
    derived_sources = DERIVED_TILE_SOURCES | DERIVED_TEXTURE_SOURCES
    marks, sources = _in_clause(derived_sources)
    return tuple(
        str(row[0]) for row in db.execute(
            f"SELECT revision_id FROM terrain_artifact_revisions "
            f"WHERE source_label IN ({marks})",
            sources,
        )
    )


def _artifact_lineage_counts(db) -> dict[str, int]:
    revision_ids = _derived_artifact_revision_ids(db)
    if not revision_ids:
        return {}
    marks = ",".join("?" for _ in revision_ids)
    return {
        "terrain_artifact_current (derived)": db.execute(
            f"SELECT COUNT(*) FROM terrain_artifact_current "
            f"WHERE revision_id IN ({marks})", revision_ids,
        ).fetchone()[0],
        "terrain_artifact_inputs (derived)": db.execute(
            f"SELECT COUNT(*) FROM terrain_artifact_inputs "
            f"WHERE output_revision_id IN ({marks}) "
            f"OR input_revision_id IN ({marks})", (*revision_ids, *revision_ids),
        ).fetchone()[0],
        "terrain_artifact_events (derived)": db.execute(
            f"SELECT COUNT(*) FROM terrain_artifact_events "
            f"WHERE from_revision_id IN ({marks}) "
            f"OR to_revision_id IN ({marks})", (*revision_ids, *revision_ids),
        ).fetchone()[0],
        "terrain_artifact_revisions (derived)": len(revision_ids),
    }


def _delete_derived_artifact_lineage(db) -> dict[str, int]:
    revision_ids = _derived_artifact_revision_ids(db)
    if not revision_ids:
        return {}
    marks = ",".join("?" for _ in revision_ids)
    deleted = {}
    deleted["terrain_artifact_current (derived)"] = db.execute(
        f"DELETE FROM terrain_artifact_current WHERE revision_id IN ({marks})",
        revision_ids,
    ).rowcount
    deleted["terrain_artifact_inputs (derived)"] = db.execute(
        f"DELETE FROM terrain_artifact_inputs "
        f"WHERE output_revision_id IN ({marks}) "
        f"OR input_revision_id IN ({marks})", (*revision_ids, *revision_ids),
    ).rowcount
    deleted["terrain_artifact_events (derived)"] = db.execute(
        f"DELETE FROM terrain_artifact_events "
        f"WHERE from_revision_id IN ({marks}) "
        f"OR to_revision_id IN ({marks})", (*revision_ids, *revision_ids),
    ).rowcount
    deleted["terrain_artifact_revisions (derived)"] = db.execute(
        f"DELETE FROM terrain_artifact_revisions WHERE revision_id IN ({marks})",
        revision_ids,
    ).rowcount
    return deleted


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

    counts.update(_artifact_lineage_counts(db))

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

    applied.update(_delete_derived_artifact_lineage(db))

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
            "[purge] rebuild inputs retained; normal demand will rebuild derivatives "
            "in whatever order their dependencies become available"
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()

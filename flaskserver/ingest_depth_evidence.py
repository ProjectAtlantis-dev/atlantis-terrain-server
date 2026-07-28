#!/usr/bin/env python3
"""Import measured depth evidence into terrain.db.

This command never writes ``bathymetry``. Source observations and their
original payloads live in the depth-evidence tables so generated terrain can
be evaluated against evidence without making the evidence circular.

Dry-run is the default.
"""

import argparse
import csv
import hashlib
import io
import json
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from database import open_db


DEFAULT_DB = Path(__file__).with_name("terrain.db")
PANGAEA_933610_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.933610?format=textfile"
)
PANGAEA_933610_SOURCE_ID = "pangaea_933610"
IMPORTER_VERSION = 1


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def read_input(location):
    if location.startswith(("https://", "http://")):
        with urllib.request.urlopen(location, timeout=60) as response:
            return response.read(), location.rsplit("/", 1)[-1] or "download"
    path = Path(location)
    return path.read_bytes(), path.name


def parse_pangaea_ctd_endpoints(payload):
    """Reduce each CTD profile to its deepest recorded sample.

    The result is a lower-bound constraint, not a seafloor observation. A
    profile is identified by event, date, station and position so repeated
    visits to a station remain separate evidence records.
    """
    text = payload.decode("utf-8-sig")
    lines = text.splitlines()
    try:
        header = next(i for i, line in enumerate(lines) if line.startswith("Event\t"))
    except StopIteration as exc:
        raise ValueError("PANGAEA payload has no Event tabular header") from exc

    reader = csv.DictReader(io.StringIO("\n".join(lines[header:])), delimiter="\t")
    required = {
        "Event", "Date/Time", "Station", "Latitude", "Longitude",
        "Depth water [m]",
    }
    missing = required - set(reader.fieldnames or ())
    if missing:
        raise ValueError(
            "PANGAEA payload is missing columns: " + ", ".join(sorted(missing))
        )

    profiles = {}
    source_rows = 0
    for row in reader:
        if not row.get("Depth water [m]"):
            continue
        source_rows += 1
        key = (
            row["Event"],
            row["Date/Time"],
            row["Station"],
            row["Latitude"],
            row["Longitude"],
        )
        depth_m = float(row["Depth water [m]"])
        previous = profiles.get(key)
        if previous is None or depth_m > previous:
            profiles[key] = depth_m

    observations = []
    for key, depth_m in sorted(profiles.items()):
        event, observed_at, station, latitude, longitude = key
        source_record_id = "|".join(key)
        digest = hashlib.sha256(source_record_id.encode("utf-8")).hexdigest()[:24]
        observations.append(
            {
                "observation_id": f"{PANGAEA_933610_SOURCE_ID}:{digest}",
                "source_record_id": source_record_id,
                "longitude_deg": float(longitude),
                "latitude_deg": float(latitude),
                "depth_m": depth_m,
                "observed_at": observed_at,
                "properties_json": json.dumps(
                    {
                        "event": event,
                        "station": station,
                        "aggregation": "maximum recorded CTD sample depth",
                        "semantic_note": (
                            "Lower bound on water depth; CTD did not necessarily "
                            "contact the seafloor."
                        ),
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            }
        )
    return source_rows, observations


def register_source(db, source):
    existing = db.execute(
        "SELECT content_sha256 FROM depth_sources WHERE source_id = ?",
        (source["source_id"],),
    ).fetchone()
    incoming_hash = source["content_sha256"]
    if (
        existing is not None
        and existing[0] is not None
        and incoming_hash is not None
        and existing[0] != incoming_hash
    ):
        raise ValueError(
            f"source {source['source_id']} already has a different content hash; "
            "use a new source_id for a revised dataset"
        )
    db.execute(
        """
        INSERT INTO depth_sources (
            source_id, title, citation, source_url, doi, provider, license,
            data_kind, original_filename, content_sha256,
            source_metadata_json, retrieved_at, updated_at
        ) VALUES (
            :source_id, :title, :citation, :source_url, :doi, :provider,
            :license, :data_kind, :original_filename, :content_sha256,
            :source_metadata_json, :retrieved_at, :updated_at
        )
        ON CONFLICT(source_id) DO UPDATE SET
            retrieved_at = excluded.retrieved_at,
            updated_at = excluded.updated_at
        """,
        source,
    )


def import_pangaea_933610(db, payload, filename, source_url, now=None):
    now = now or utc_now()
    sha256 = hashlib.sha256(payload).hexdigest()
    source_rows, observations = parse_pangaea_ctd_endpoints(payload)
    source = {
        "source_id": PANGAEA_933610_SOURCE_ID,
        "title": (
            "Seasonal temperature and salinity depth measurements from "
            "southwest Greenland fjords in 2019"
        ),
        "citation": (
            "Stuart-Lee, Alice; Meire, Lorenz; Mortensen, John (2021): "
            "Seasonal temperature and salinity depth measurements from "
            "southwest Greenland fjords in 2019. PANGAEA, "
            "https://doi.org/10.1594/PANGAEA.933610"
        ),
        "source_url": source_url,
        "doi": "10.1594/PANGAEA.933610",
        "provider": "PANGAEA",
        "license": "CC-BY-4.0",
        "data_kind": "point_observations",
        "original_filename": filename,
        "content_sha256": sha256,
        "source_metadata_json": json.dumps(
            {
                "regions": ["Ameralik", "Godthåbsfjord"],
                "instrument": "Sea-Bird SBE19plus CTD",
                "normalization": (
                    "one endpoint per Event/Date/Station/Latitude/Longitude "
                    "profile, using the maximum sampled water depth"
                ),
                "evidence_kind": "minimum_depth",
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        "retrieved_at": now,
        "updated_at": now,
    }
    register_source(db, source)

    asset_id = f"{PANGAEA_933610_SOURCE_ID}:raw:{sha256[:16]}"
    db.execute(
        """
        INSERT INTO depth_assets (
            asset_id, source_id, filename, media_type, payload, byte_length,
            content_sha256, evidence_kind, measurement_method, horizontal_crs,
            vertical_datum, resolution_m, west_deg, south_deg, east_deg,
            north_deg, metadata_json, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO NOTHING
        """,
        (
            asset_id,
            PANGAEA_933610_SOURCE_ID,
            filename,
            "text/tab-separated-values",
            payload,
            len(payload),
            sha256,
            "minimum_depth",
            "ctd_profile",
            "EPSG:4326",
            "instantaneous_water_surface",
            -52.182400,
            64.050567,
            -50.013450,
            64.717000,
            json.dumps(
                {
                    "raw_data_rows": source_rows,
                    "normalized_profile_endpoints": len(observations),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            now,
        ),
    )

    for observation in observations:
        db.execute(
            """
            INSERT INTO depth_observations (
                observation_id, source_id, source_record_id, longitude_deg,
                latitude_deg, depth_m, evidence_kind, measurement_method,
                observed_at, horizontal_datum, vertical_datum,
                horizontal_accuracy_m, vertical_accuracy_m, properties_json,
                imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            ON CONFLICT(observation_id) DO UPDATE SET
                depth_m = excluded.depth_m,
                properties_json = excluded.properties_json,
                imported_at = excluded.imported_at
            """,
            (
                observation["observation_id"],
                PANGAEA_933610_SOURCE_ID,
                observation["source_record_id"],
                observation["longitude_deg"],
                observation["latitude_deg"],
                observation["depth_m"],
                "minimum_depth",
                "ctd_cast_endpoint",
                observation["observed_at"],
                "EPSG:4326",
                "instantaneous_water_surface",
                observation["properties_json"],
                now,
            ),
        )

    import_id = (
        f"{PANGAEA_933610_SOURCE_ID}:ctd_endpoints_v{IMPORTER_VERSION}:"
        f"{sha256[:16]}"
    )
    db.execute(
        """
        INSERT INTO depth_imports (
            import_id, source_id, importer, importer_version, input_sha256,
            source_row_count, observation_count, asset_count, started_at,
            completed_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(import_id) DO UPDATE SET
            completed_at = excluded.completed_at,
            source_row_count = excluded.source_row_count,
            observation_count = excluded.observation_count
        """,
        (
            import_id,
            PANGAEA_933610_SOURCE_ID,
            "ingest_depth_evidence:pangaea-933610",
            IMPORTER_VERSION,
            sha256,
            source_rows,
            len(observations),
            now,
            now,
            "CTD profile endpoints imported as minimum-depth constraints.",
        ),
    )
    return {
        "source_rows": source_rows,
        "observations": len(observations),
        "assets": 1,
        "sha256": sha256,
    }


def print_status(db):
    rows = db.execute(
        """
        SELECT s.source_id, s.data_kind,
               COALESCE(o.observations, 0),
               COALESCE(a.assets, 0),
               COALESCE(a.bytes, 0),
               COALESCE(o.bottom_depths, 0),
               COALESCE(o.minimum_depths, 0)
        FROM depth_sources s
        LEFT JOIN (
            SELECT source_id, COUNT(*) observations,
                   SUM(evidence_kind = 'seafloor_depth') bottom_depths,
                   SUM(evidence_kind = 'minimum_depth') minimum_depths
            FROM depth_observations GROUP BY source_id
        ) o USING (source_id)
        LEFT JOIN (
            SELECT source_id, COUNT(*) assets, SUM(byte_length) bytes
            FROM depth_assets GROUP BY source_id
        ) a USING (source_id)
        ORDER BY s.source_id
        """
    ).fetchall()
    print(
        "source_id\tdata_kind\tobservations\tassets\tbytes\t"
        "seafloor_depth\tminimum_depth"
    )
    for row in rows:
        print("\t".join(str(value) for value in row))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    subparsers = parser.add_subparsers(dest="command", required=True)

    pangaea = subparsers.add_parser(
        "pangaea-933610",
        help="import Ameralik/Godthåbsfjord CTD endpoints as minimum depths",
    )
    pangaea.add_argument("--input", default=PANGAEA_933610_URL)
    pangaea.add_argument("--commit", action="store_true")

    subparsers.add_parser("status", help="summarize stored depth evidence")
    args = parser.parse_args(argv)

    if args.command == "status":
        db = sqlite3.connect(f"file:{args.db.resolve()}?mode=ro", uri=True)
        try:
            print_status(db)
        finally:
            db.close()
        return 0

    payload, filename = read_input(args.input)
    source_rows, observations = parse_pangaea_ctd_endpoints(payload)
    sha256 = hashlib.sha256(payload).hexdigest()
    print(
        f"PANGAEA 933610: {source_rows:,} CTD samples -> "
        f"{len(observations):,} profile endpoints; sha256={sha256}"
    )
    print(
        "Evidence semantics: minimum_depth "
        "(the CTD endpoint is not a measured seafloor depth)."
    )
    if not args.commit:
        print("DRY RUN — nothing changed. Re-run with --commit.")
        return 0

    db = open_db(str(args.db))
    try:
        result = import_pangaea_933610(
            db,
            payload,
            filename,
            PANGAEA_933610_URL
            if args.input == PANGAEA_933610_URL
            else str(Path(args.input).resolve()),
        )
        db.commit()
        print(
            f"Stored {result['observations']:,} observations and the original "
            f"{result['assets']:,} source asset in {args.db}."
        )
        print_status(db)
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

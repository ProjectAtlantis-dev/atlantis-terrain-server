#!/usr/bin/env python3
"""Import sourced point depths into terrain.db. Dry-run is the default."""

import argparse
import csv
import io
import sqlite3
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import xy
from rasterio.warp import transform

from database import open_db
from terrain_config import GREENLAND_BBOX


DEFAULT_DB = Path(__file__).with_name("terrain.db")
PANGAEA_933610_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.933610?format=textfile"
)
PANGAEA_992416_URL = "https://doi.org/10.1594/PANGAEA.992416"
PANGAEA_992416_FILE_URL = (
    "https://download.pangaea.de/dataset/992416/files/"
    "Multibeam_backscatter_50m_32622_NaN.tif"
)
VALIDATION_TILE_DEPTH = 12


def read_input(location):
    if location.startswith(("https://", "http://")):
        with urllib.request.urlopen(location, timeout=60) as response:
            return response.read()
    return Path(location).read_bytes()


def parse_pangaea_ctd_endpoints(payload):
    """Reduce each CTD profile to its deepest recorded sample."""
    lines = payload.decode("utf-8-sig").splitlines()
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
        if key not in profiles or depth_m > profiles[key]:
            profiles[key] = depth_m

    soundings = []
    for key, depth_m in sorted(profiles.items()):
        event, observed_at, station, latitude, longitude = key
        soundings.append(
            {
                "record_id": "|".join((event, observed_at, station)),
                "latitude": float(latitude),
                "longitude": float(longitude),
                "depth_m": depth_m,
            }
        )
    return source_rows, soundings


def tile_address(x, y):
    x_min, y_min, x_max, y_max = GREENLAND_BBOX
    tiles_per_axis = 1 << VALIDATION_TILE_DEPTH
    col = int(np.floor((x - x_min) / ((x_max - x_min) / tiles_per_axis)))
    row = int(np.floor((y - y_min) / ((y_max - y_min) / tiles_per_axis)))
    if not (0 <= col < tiles_per_axis and 0 <= row < tiles_per_axis):
        return None
    return f"{VALIDATION_TILE_DEPTH}-{col}-{row}"


def aggregate_ctd_endpoints(soundings):
    """Keep the strongest lower-bound check in each depth-12 tile."""
    longitudes = [row["longitude"] for row in soundings]
    latitudes = [row["latitude"] for row in soundings]
    xs, ys = transform("EPSG:4326", "EPSG:3413", longitudes, latitudes)
    by_tile = {}
    for sounding, x, y in zip(soundings, xs, ys):
        record_id = tile_address(x, y)
        if record_id is None:
            continue
        previous = by_tile.get(record_id)
        if previous is None or sounding["depth_m"] > previous["depth_m"]:
            by_tile[record_id] = {**sounding, "record_id": record_id}
    return [by_tile[key] for key in sorted(by_tile)]


def import_pangaea_933610(db, payload):
    source_rows, endpoints = parse_pangaea_ctd_endpoints(payload)
    soundings = aggregate_ctd_endpoints(endpoints)
    db.execute(
        "DELETE FROM soundings WHERE source_url = ?",
        (PANGAEA_933610_URL,),
    )
    db.executemany(
        """
        INSERT INTO soundings (
            source_url, record_id, latitude, longitude, depth_m, depth_kind
        ) VALUES (?, ?, ?, ?, ?, 'at_least')
        ON CONFLICT(source_url, record_id) DO UPDATE SET
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            depth_m = excluded.depth_m,
            depth_kind = excluded.depth_kind
        """,
        (
            (
                PANGAEA_933610_URL,
                row["record_id"],
                row["latitude"],
                row["longitude"],
                row["depth_m"],
            )
            for row in soundings
        ),
    )
    return source_rows, len(soundings)


def aggregate_pangaea_992416(path):
    """Average the multibeam cells within each depth-12 terrain tile."""
    cells = 0
    by_tile = {}
    with rasterio.open(path) as raster:
        for row_start in range(0, raster.height, 256):
            row_stop = min(row_start + 256, raster.height)
            data = raster.read(
                1,
                window=((row_start, row_stop), (0, raster.width)),
                masked=True,
            )
            valid = (~np.ma.getmaskarray(data)) & np.isfinite(data.data)
            valid &= data.data < 0.0
            local_rows, cols = np.nonzero(valid)
            rows = local_rows + row_start
            eastings, northings = xy(raster.transform, rows, cols)
            xs, ys = transform(raster.crs, "EPSG:3413", eastings, northings)
            depths = -data.data[local_rows, cols]
            cells += len(depths)
            for x, y, depth in zip(xs, ys, depths):
                record_id = tile_address(x, y)
                if record_id is None:
                    continue
                totals = by_tile.setdefault(record_id, [0.0, 0.0, 0.0, 0])
                totals[0] += x
                totals[1] += y
                totals[2] += float(depth)
                totals[3] += 1

    keys = sorted(by_tile)
    mean_xs = [by_tile[key][0] / by_tile[key][3] for key in keys]
    mean_ys = [by_tile[key][1] / by_tile[key][3] for key in keys]
    longitudes, latitudes = transform(
        "EPSG:3413", "EPSG:4326", mean_xs, mean_ys
    )
    soundings = [
        {
            "record_id": key,
            "latitude": float(latitude),
            "longitude": float(longitude),
            "depth_m": by_tile[key][2] / by_tile[key][3],
        }
        for key, latitude, longitude in zip(keys, latitudes, longitudes)
    ]
    return cells, soundings


def import_pangaea_992416(db, path):
    cells, soundings = aggregate_pangaea_992416(path)
    db.execute(
        "DELETE FROM soundings WHERE source_url = ?",
        (PANGAEA_992416_URL,),
    )
    db.executemany(
        """
        INSERT INTO soundings (
            source_url, record_id, latitude, longitude, depth_m, depth_kind
        ) VALUES (?, ?, ?, ?, ?, 'actual')
        """,
        (
            (
                PANGAEA_992416_URL,
                row["record_id"],
                row["latitude"],
                row["longitude"],
                row["depth_m"],
            )
            for row in soundings
        ),
    )
    return cells, len(soundings)


def local_raster(location):
    if not location.startswith(("https://", "http://")):
        return Path(location), None
    temporary = tempfile.NamedTemporaryFile(suffix=".tif", delete=False)
    temporary.close()
    urllib.request.urlretrieve(location, temporary.name)
    return Path(temporary.name), Path(temporary.name)


def print_status(db):
    rows = db.execute(
        """
        SELECT source_url, COUNT(*),
               SUM(depth_kind = 'actual'),
               SUM(depth_kind = 'at_least')
        FROM soundings
        GROUP BY source_url
        ORDER BY source_url
        """
    ).fetchall()
    print("source_url\trows\tactual\tat_least")
    for row in rows:
        print("\t".join(str(value) for value in row))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    subparsers = parser.add_subparsers(dest="command", required=True)

    pangaea = subparsers.add_parser(
        "pangaea-933610",
        help="import Ameralik/Godthåbsfjord CTD endpoints as lower bounds",
    )
    pangaea.add_argument("--input", default=PANGAEA_933610_URL)
    pangaea.add_argument("--commit", action="store_true")

    multibeam = subparsers.add_parser(
        "pangaea-992416",
        help="import the 50 m Nuup Kangerlua multibeam grid as actual depths",
    )
    multibeam.add_argument("--input", default=PANGAEA_992416_FILE_URL)
    multibeam.add_argument("--commit", action="store_true")
    subparsers.add_parser("status", help="summarize stored depth rows")
    args = parser.parse_args(argv)

    if args.command == "status":
        db = sqlite3.connect(f"file:{args.db.resolve()}?mode=ro", uri=True)
        try:
            print_status(db)
        finally:
            db.close()
        return 0

    if args.command == "pangaea-933610":
        payload = read_input(args.input)
        source_rows, endpoints = parse_pangaea_ctd_endpoints(payload)
        soundings = aggregate_ctd_endpoints(endpoints)
        print(
            f"PANGAEA 933610: {source_rows:,} CTD samples -> "
            f"{len(endpoints):,} profile endpoints -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: at_least (a CTD endpoint is not a bottom sounding).")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, count = import_pangaea_933610(db, payload)
            db.commit()
            print(f"Stored {count:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    raster_path, temporary_path = local_raster(args.input)
    try:
        cells, soundings = aggregate_pangaea_992416(raster_path)
        print(
            f"PANGAEA 992416: {cells:,} underwater 50 m cells -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: actual.")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, stored = import_pangaea_992416(db, raster_path)
            db.commit()
            print(f"Stored {stored:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
    finally:
        if temporary_path is not None:
            temporary_path.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

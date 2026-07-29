#!/usr/bin/env python3
"""Import sourced point depths into terrain.db. Dry-run is the default."""

import argparse
import csv
import hashlib
import io
import re
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import xy
from rasterio.warp import transform

from coords import to_stereo
from database import open_db
from terrain_config import GREENLAND_BBOX
from tile_address import inset_tile_corners


DEFAULT_DB = Path(__file__).with_name("terrain.db")
PANGAEA_933610_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.933610?format=textfile"
)
PANGAEA_992416_URL = "https://doi.org/10.1594/PANGAEA.992416"
PANGAEA_992416_FILENAME = "Multibeam_bathymetry_50m_32622_NaN.tif"
PANGAEA_992416_SHA256 = (
    "3ce13a40f67299a96003b17d416ad2b6df1c1f60bd9aab118c038777954a67e4"
)
PANGAEA_992416_FILE_URL = (
    "https://download.pangaea.de/dataset/992416/files/"
    f"{PANGAEA_992416_FILENAME}"
)
PANGAEA_992416_NOTE = (
    "Qualified actual: PANGAEA manifest swaps bathymetry/backscatter Content "
    f"labels. Imported checksum-pinned {PANGAEA_992416_FILENAME} after "
    "value-range and Ameralik CTD checks; public grid is 50 m, vertical datum "
    "is listed as none, and the source is not suitable for navigation."
)
PANGAEA_770247_URL = "https://doi.org/10.1594/PANGAEA.770247"
PANGAEA_770247_FILE_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.770247?format=textfile"
)
PANGAEA_935639_URL = "https://doi.org/10.1594/PANGAEA.935639"
PANGAEA_935639_FILE_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.935639?format=textfile"
)
PANGAEA_921991_URL = "https://doi.org/10.1594/PANGAEA.921991"
PANGAEA_921991_FILE_URL = (
    "https://doi.pangaea.de/10.1594/PANGAEA.921991"
    "?format=zip&charset=UTF-8"
)
VALIDATION_TILE_DEPTH = 12
CORNER_FIELDS = (
    "evidence_sw_m",
    "evidence_se_m",
    "evidence_nw_m",
    "evidence_ne_m",
)


def evidence_kind_for_source(
    source_url,
    requested_kind,
    *,
    evidence_format="point",
    source_asset=None,
    source_sha256=None,
):
    """Apply repository-level trust policy before evidence reaches SQLite."""
    normalized = str(source_url).casefold()
    if "pangaea." not in normalized:
        return requested_kind
    asset = str(source_asset or "").casefold()
    if (
        evidence_format == "raster"
        and asset.endswith((".tif", ".tiff"))
        and source_sha256 is not None
    ):
        return requested_kind
    return "at_least"


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _raster_provenance(paths):
    paths = [Path(path) for path in paths]
    hashes = [_sha256_file(path) for path in paths]
    if len(hashes) == 1:
        bundle_hash = hashes[0]
    else:
        digest = hashlib.sha256()
        for path, asset_hash in sorted(
            zip(paths, hashes), key=lambda item: item[0].name
        ):
            digest.update(path.name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(asset_hash.encode("ascii"))
            digest.update(b"\n")
        bundle_hash = digest.hexdigest()
    return ",".join(path.name for path in paths), bundle_hash


def read_input(location):
    if location.startswith(("https://", "http://")):
        with urllib.request.urlopen(location, timeout=60) as response:
            return response.read()
    return Path(location).read_bytes()


_EVENT_POSITION_RE = re.compile(
    r"^(?:Event\(s\):\t|\t)(.*?) \* .*?"
    r"LATITUDE(?: START)?:\s*(-?\d+(?:\.\d+)?).*?"
    r"LONGITUDE(?: START)?:\s*(-?\d+(?:\.\d+)?)"
)


def _column(fieldnames, name):
    return next(
        (field for field in fieldnames if field.casefold() == name.casefold()),
        None,
    )


def parse_pangaea_ctd_endpoints(payload):
    """Reduce each PANGAEA CTD profile to its deepest recorded sample."""
    lines = payload.decode("utf-8-sig").splitlines()
    header = next(
        (
            index
            for index, line in enumerate(lines)
            if (
                "Event" in line.split("\t")
                or "Station" in line.split("\t")
            )
            and any(
                field.startswith("Depth water")
                for field in line.split("\t")
            )
        ),
        None,
    )
    if header is None:
        raise ValueError("PANGAEA payload has no Event tabular header")

    event_positions = {}
    for line in lines[:header]:
        match = _EVENT_POSITION_RE.search(line)
        if match:
            event_positions[match.group(1)] = (
                float(match.group(2)),
                float(match.group(3)),
            )

    reader = csv.DictReader(io.StringIO("\n".join(lines[header:])), delimiter="\t")
    fieldnames = reader.fieldnames or ()
    event_column = _column(fieldnames, "Event")
    profile_column = event_column or _column(fieldnames, "Station")
    latitude_column = _column(fieldnames, "Latitude")
    longitude_column = _column(fieldnames, "Longitude")
    observed_at_column = _column(fieldnames, "Date/Time")
    station_column = _column(fieldnames, "Station")
    depth_column = next(
        (field for field in fieldnames if field.startswith("Depth water")),
        None,
    )
    if profile_column is None or depth_column is None:
        raise ValueError("PANGAEA payload has no Event/Station and depth columns")

    profiles = {}
    source_rows = 0
    for row in reader:
        if not row.get(depth_column):
            continue
        event = row[profile_column]
        if (
            latitude_column is not None
            and longitude_column is not None
            and row.get(latitude_column)
            and row.get(longitude_column)
        ):
            latitude = float(row[latitude_column])
            longitude = float(row[longitude_column])
        else:
            try:
                latitude, longitude = event_positions[event]
            except KeyError as exc:
                raise ValueError(
                    f"PANGAEA event {event!r} has no position"
                ) from exc

        source_rows += 1
        key = (
            event,
            row.get(observed_at_column, "") if observed_at_column else "",
            (
                row.get(station_column, "")
                if station_column and station_column != profile_column
                else ""
            ),
            latitude,
            longitude,
        )
        depth_m = float(row[depth_column])
        if not np.isfinite(depth_m) or depth_m <= 0.0:
            continue
        if key not in profiles or depth_m > profiles[key]:
            profiles[key] = depth_m

    soundings = []
    for key, depth_m in sorted(profiles.items()):
        event, observed_at, station, latitude, longitude = key
        soundings.append(
            {
                "record_id": "|".join(
                    value for value in (event, observed_at, station) if value
                ),
                "latitude": latitude,
                "longitude": longitude,
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


def add_actual_points(by_tile, longitudes, latitudes, depths):
    xs, ys = transform("EPSG:4326", "EPSG:3413", longitudes, latitudes)
    for x, y, depth in zip(xs, ys, depths):
        record_id = tile_address(x, y)
        if record_id is None:
            continue
        totals = by_tile.setdefault(record_id, [0.0, 0.0, 0.0, 0])
        totals[0] += x
        totals[1] += y
        totals[2] += depth
        totals[3] += 1


def finish_actual_points(by_tile):
    keys = sorted(by_tile)
    mean_xs = [by_tile[key][0] / by_tile[key][3] for key in keys]
    mean_ys = [by_tile[key][1] / by_tile[key][3] for key in keys]
    longitudes, latitudes = transform(
        "EPSG:3413", "EPSG:4326", mean_xs, mean_ys
    )
    return [
        {
            "record_id": key,
            "latitude": float(latitude),
            "longitude": float(longitude),
            "depth_m": by_tile[key][2] / by_tile[key][3],
        }
        for key, latitude, longitude in zip(keys, latitudes, longitudes)
    ]


def replace_soundings(
    db,
    source_url,
    depth_kind,
    soundings,
    *,
    evidence_note=None,
    evidence_format="point",
    source_asset=None,
    source_sha256=None,
):
    depth_kind = evidence_kind_for_source(
        source_url,
        depth_kind,
        evidence_format=evidence_format,
        source_asset=source_asset,
        source_sha256=source_sha256,
    )
    rows = list(soundings)
    if rows:
        stereo_xs, stereo_ys = to_stereo(
            np.asarray([row["latitude"] for row in rows], dtype=np.float64),
            np.asarray([row["longitude"] for row in rows], dtype=np.float64),
        )
    else:
        stereo_xs, stereo_ys = np.asarray([]), np.asarray([])
    db.execute("DELETE FROM soundings WHERE source_url = ?", (source_url,))
    db.executemany(
        """
        INSERT INTO soundings (
            source_url, record_id, latitude, longitude, stereo_x, stereo_y,
            depth_m, depth_kind, evidence_note, evidence_format, source_asset,
            source_sha256, evidence_sw_m, evidence_se_m, evidence_nw_m,
            evidence_ne_m, comparison_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                source_url,
                row["record_id"],
                row["latitude"],
                row["longitude"],
                float(stereo_x),
                float(stereo_y),
                row["depth_m"],
                depth_kind,
                evidence_note,
                evidence_format,
                source_asset,
                source_sha256,
                row.get("evidence_sw_m"),
                row.get("evidence_se_m"),
                row.get("evidence_nw_m"),
                row.get("evidence_ne_m"),
                (
                    "corner_rms"
                    if evidence_format == "raster"
                    else "point"
                ),
            )
            for row, stereo_x, stereo_y in zip(rows, stereo_xs, stereo_ys)
        ),
    )
    # Imports that land inside already-generated coverage are compared in the
    # same transaction. A later bathymetry generation refreshes its own tile.
    from bathymetry_health import refresh_sounding_health

    refresh_sounding_health(db, source_url=source_url)


def import_pangaea_933610(db, payload):
    return import_pangaea_ctd(db, payload, PANGAEA_933610_URL)


def import_pangaea_ctd(db, payload, source_url):
    source_rows, endpoints = parse_pangaea_ctd_endpoints(payload)
    soundings = aggregate_ctd_endpoints(endpoints)
    replace_soundings(
        db, source_url, "at_least", soundings, evidence_format="ctd"
    )
    return source_rows, len(soundings)


def aggregate_pangaea_bathymetry(payload, depth_column_index=0):
    """Average a tabular PANGAEA bathymetry dataset by depth-12 tile."""
    lines = payload.decode("utf-8-sig").splitlines()
    header = None
    depth_column = None
    for index, line in enumerate(lines):
        fields = line.split("\t")
        depths = [field for field in fields if field.startswith("Bathy depth")]
        if (
            "Latitude" in fields
            and "Longitude" in fields
            and len(depths) > depth_column_index
        ):
            header = index
            depth_column = depths[depth_column_index]
            break
    if header is None:
        raise ValueError(
            "PANGAEA payload has no matching bathymetry depth column"
        )

    reader = csv.DictReader(io.StringIO("\n".join(lines[header:])), delimiter="\t")
    by_tile = {}
    source_rows = 0
    longitudes = []
    latitudes = []
    depths = []

    def flush():
        if longitudes:
            add_actual_points(by_tile, longitudes, latitudes, depths)
            longitudes.clear()
            latitudes.clear()
            depths.clear()

    for row in reader:
        if not row.get("Latitude") or not row.get("Longitude"):
            continue
        raw_depth = row.get(depth_column)
        if not raw_depth:
            continue
        depth = float(raw_depth)
        if not np.isfinite(depth) or depth <= 0.0:
            continue
        source_rows += 1
        latitudes.append(float(row["Latitude"]))
        longitudes.append(float(row["Longitude"]))
        depths.append(depth)
        if len(depths) == 10000:
            flush()
    flush()
    return source_rows, finish_actual_points(by_tile)


def import_pangaea_bathymetry(
    db, payload, source_url, depth_column_index=0
):
    source_rows, soundings = aggregate_pangaea_bathymetry(
        payload, depth_column_index
    )
    replace_soundings(
        db, source_url, "actual", soundings, evidence_format="table"
    )
    return source_rows, len(soundings)


_LAT_LON_RE = re.compile(
    r"LATITUDE:\s*(-?\d+(?:\.\d+)?).*LONGITUDE:\s*(-?\d+(?:\.\d+)?)"
)


def parse_pangaea_ctd_bundle(payload):
    """Extract one lower-bound endpoint from every CTD table in a ZIP."""
    endpoints = []
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for filename in sorted(archive.namelist()):
            if not filename.endswith(".tab"):
                continue
            lines = archive.read(filename).decode("utf-8-sig").splitlines()
            coordinates = None
            for line in lines:
                if line.startswith("Coverage:"):
                    coordinates = _LAT_LON_RE.search(line)
                    break
            if coordinates is None:
                raise ValueError(f"{filename} has no coverage position")

            header = next(
                (
                    index
                    for index, line in enumerate(lines)
                    if "Depth water" in line.split("\t")
                    or any(
                        field.startswith("Depth water [")
                        for field in line.split("\t")
                    )
                ),
                None,
            )
            if header is None:
                raise ValueError(f"{filename} has no depth table")
            reader = csv.DictReader(
                io.StringIO("\n".join(lines[header:])), delimiter="\t"
            )
            depth_column = next(
                field
                for field in (reader.fieldnames or ())
                if field.startswith("Depth water")
            )
            depth = max(
                float(row[depth_column])
                for row in reader
                if row.get(depth_column)
            )
            endpoints.append(
                {
                    "record_id": Path(filename).stem,
                    "latitude": float(coordinates.group(1)),
                    "longitude": float(coordinates.group(2)),
                    "depth_m": depth,
                }
            )
    return endpoints


def import_pangaea_921991(db, payload):
    endpoints = parse_pangaea_ctd_bundle(payload)
    soundings = aggregate_ctd_endpoints(endpoints)
    replace_soundings(
        db,
        PANGAEA_921991_URL,
        "at_least",
        soundings,
        evidence_format="ctd",
    )
    return len(endpoints), len(soundings)


def _raster_source_crs(raster):
    if raster.crs is not None:
        return raster.crs
    bounds = raster.bounds
    if (
        -180.0 <= bounds.left <= 180.0
        and -180.0 <= bounds.right <= 180.0
        and -90.0 <= bounds.bottom <= 90.0
        and -90.0 <= bounds.top <= 90.0
    ):
        return "EPSG:4326"
    raise ValueError(
        f"{raster.name} has no CRS and its bounds are not longitude/latitude"
    )


def aggregate_rasters(paths, depth_sign):
    """Keep tile means plus matched corner evidence for RMS validation."""
    if depth_sign not in {"negative", "positive"}:
        raise ValueError("depth_sign must be 'negative' or 'positive'")
    paths = [Path(path) for path in paths]

    cells = 0
    by_tile = {}
    for path in paths:
        with rasterio.open(path) as raster:
            source_crs = _raster_source_crs(raster)
            for row_start in range(0, raster.height, 256):
                row_stop = min(row_start + 256, raster.height)
                data = raster.read(
                    1,
                    window=((row_start, row_stop), (0, raster.width)),
                    masked=True,
                )
                valid = (~np.ma.getmaskarray(data)) & np.isfinite(data.data)
                if depth_sign == "negative":
                    valid &= data.data < 0.0
                else:
                    valid &= data.data > 0.0
                local_rows, cols = np.nonzero(valid)
                rows = local_rows + row_start
                eastings, northings = xy(raster.transform, rows, cols)
                xs, ys = transform(
                    source_crs, "EPSG:3413", eastings, northings
                )
                values = data.data[local_rows, cols]
                depths = -values if depth_sign == "negative" else values
                cells += len(depths)
                for x, y, depth in zip(xs, ys, depths):
                    record_id = tile_address(x, y)
                    if record_id is None:
                        continue
                    totals = by_tile.setdefault(
                        record_id, [0.0, 0.0, 0.0, 0]
                    )
                    totals[0] += x
                    totals[1] += y
                    totals[2] += float(depth)
                    totals[3] += 1

    soundings = finish_actual_points(by_tile)
    _attach_raster_corner_evidence(paths, soundings, depth_sign)
    return cells, soundings


def _attach_raster_corner_evidence(paths, soundings, depth_sign):
    """Sample every source at matching validation-tile corner coordinates."""
    if not soundings:
        return
    points = [
        point
        for row in soundings
        for point in inset_tile_corners(row["record_id"], GREENLAND_BBOX)
    ]
    sums = np.zeros((len(soundings), len(CORNER_FIELDS)), dtype=np.float64)
    counts = np.zeros((len(soundings), len(CORNER_FIELDS)), dtype=np.int32)
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    for path in paths:
        with rasterio.open(path) as raster:
            source_crs = _raster_source_crs(raster)
            source_xs, source_ys = transform(
                "EPSG:3413", source_crs, xs, ys
            )
            for index, sample in enumerate(
                raster.sample(zip(source_xs, source_ys), masked=True)
            ):
                value = sample[0]
                if np.ma.is_masked(value):
                    continue
                value = float(value)
                if not np.isfinite(value):
                    continue
                if depth_sign == "negative":
                    if value >= 0.0:
                        continue
                    depth = -value
                else:
                    if value <= 0.0:
                        continue
                    depth = value
                row_index, corner_index = divmod(index, len(CORNER_FIELDS))
                sums[row_index, corner_index] += depth
                counts[row_index, corner_index] += 1
    for row_index, row in enumerate(soundings):
        for corner_index, field in enumerate(CORNER_FIELDS):
            count = int(counts[row_index, corner_index])
            row[field] = (
                float(sums[row_index, corner_index] / count)
                if count
                else None
            )


def aggregate_pangaea_992416(path):
    minimum = np.inf
    maximum = -np.inf
    with rasterio.open(path) as raster:
        for _, window in raster.block_windows(1):
            values = raster.read(1, window=window, masked=True).compressed()
            if values.size:
                minimum = min(minimum, float(np.min(values)))
                maximum = max(maximum, float(np.max(values)))
    if not np.isfinite(minimum) or maximum >= 0.0 or minimum > -100.0:
        raise ValueError(
            "PANGAEA 992416 raster does not look like bathymetry: expected "
            "only negative elevations extending below -100 m, got "
            f"{minimum:g}..{maximum:g}"
        )
    return aggregate_rasters([path], "negative")


def import_rasters(db, paths, source_url, depth_sign):
    paths = [Path(path) for path in paths]
    cells, soundings = aggregate_rasters(paths, depth_sign)
    source_asset, source_sha256 = _raster_provenance(paths)
    replace_soundings(
        db,
        source_url,
        "actual",
        soundings,
        evidence_format="raster",
        source_asset=source_asset,
        source_sha256=source_sha256,
    )
    return cells, len(soundings)


def parse_pangaea_bathymetry_files(payload, dataset_id):
    """Return bathymetry raster names and URLs from a PANGAEA manifest."""
    lines = payload.decode("utf-8-sig").splitlines()
    header = next(
        (
            index
            for index, line in enumerate(lines)
            if "Content" in line.split("\t")
            and (
                "Binary" in line.split("\t")
                or "File name" in line.split("\t")
            )
        ),
        None,
    )
    if header is None:
        raise ValueError("PANGAEA payload has no binary file manifest")

    reader = csv.DictReader(io.StringIO("\n".join(lines[header:])), delimiter="\t")
    files = []
    for row in reader:
        filename = row.get("Binary") or row.get("File name")
        content = (row.get("Content") or "").casefold()
        if not filename or not filename.casefold().endswith((".tif", ".tiff")):
            continue
        if dataset_id == "992416":
            # This manifest's filename and Content labels are cross-wired.
            # File distributions and Ameralik CTD checks confirm that the
            # bathymetry-named raster is the actual negative-elevation grid.
            if filename != PANGAEA_992416_FILENAME:
                continue
            content = "bathymetry"
        if not ("bathymetr" in content or "seafloor depth" in content):
            continue
        if any(
            excluded in content
            for excluded in ("backscatter", "standard deviation", "number of")
        ):
            continue
        if Path(filename).name != filename:
            raise ValueError(f"unsafe PANGAEA filename: {filename!r}")
        url = row.get("URL file") or (
            f"https://download.pangaea.de/dataset/{dataset_id}/files/"
            f"{filename}"
        )
        files.append((filename, url))
    if not files:
        raise ValueError("PANGAEA manifest has no bathymetry TIFF files")
    return files


def download_with_run_curl(url, destination):
    """Download atomically through the repository's approved curl wrapper."""
    destination = Path(destination)
    if destination.is_file() and destination.stat().st_size > 0:
        return
    partial = destination.with_name(destination.name + ".part")
    partial.unlink(missing_ok=True)
    run_curl = Path(__file__).resolve().parent.parent / "runCurl"
    try:
        subprocess.run(
            [
                str(run_curl),
                "--silent",
                "--show-error",
                "--output",
                str(partial),
                url,
            ],
            check=True,
        )
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def fetch_pangaea_bathymetry_files(
    payload, dataset_id, cache_dir, pause_seconds=1.0
):
    cache_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    failures = []
    for filename, url in parse_pangaea_bathymetry_files(payload, dataset_id):
        path = cache_dir / filename
        try:
            download_with_run_curl(url, path)
        except subprocess.CalledProcessError:
            failures.append(filename)
        else:
            paths.append(path)
        time.sleep(pause_seconds)
    if failures:
        raise RuntimeError(
            "PANGAEA downloads incomplete; cached successful files and "
            f"left database unchanged. Failed: {', '.join(failures)}"
        )
    return paths


def import_pangaea_992416(db, path):
    raster_path = Path(path)
    if "backscatter" in raster_path.name.casefold():
        raise ValueError(
            "refusing to import PANGAEA 992416 backscatter as bathymetry"
        )
    source_sha256 = _sha256_file(raster_path)
    if source_sha256 != PANGAEA_992416_SHA256:
        raise ValueError(
            "refusing to import PANGAEA 992416: TIFF checksum does not match "
            "the independently validated official bathymetry asset"
        )
    cells, soundings = aggregate_pangaea_992416(raster_path)
    replace_soundings(
        db,
        PANGAEA_992416_URL,
        "actual",
        soundings,
        evidence_note=PANGAEA_992416_NOTE,
        evidence_format="raster",
        source_asset=PANGAEA_992416_FILENAME,
        source_sha256=source_sha256,
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
        WHERE evidence_status = 'accepted'
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

    disko = subparsers.add_parser(
        "pangaea-770247",
        help="import the Disko Bay gridded multibeam depth table",
    )
    disko.add_argument("--input", default=PANGAEA_770247_FILE_URL)
    disko.add_argument("--commit", action="store_true")

    ground_truth = subparsers.add_parser(
        "pangaea-935639",
        help="import Disko Bay multibeam-derived ground-truth depths",
    )
    ground_truth.add_argument("--input", default=PANGAEA_935639_FILE_URL)
    ground_truth.add_argument("--commit", action="store_true")

    ctd_bundle = subparsers.add_parser(
        "pangaea-921991",
        help="import 18 West Greenland CTD endpoints as lower bounds",
    )
    ctd_bundle.add_argument("--input", default=PANGAEA_921991_FILE_URL)
    ctd_bundle.add_argument("--commit", action="store_true")

    generic_ctd = subparsers.add_parser(
        "pangaea-ctd",
        help="import a PANGAEA CTD table as depth lower bounds",
    )
    generic_ctd.add_argument("--source-url", required=True)
    generic_ctd.add_argument("--input", required=True)
    generic_ctd.add_argument("--commit", action="store_true")

    generic_raster = subparsers.add_parser(
        "raster",
        help="import one or more measured bathymetry rasters",
    )
    generic_raster.add_argument("--source-url", required=True)
    generic_raster.add_argument(
        "--depth-sign",
        choices=("negative", "positive"),
        required=True,
    )
    generic_raster.add_argument(
        "--input", type=Path, nargs="+", required=True
    )
    generic_raster.add_argument("--commit", action="store_true")

    generic_bathymetry = subparsers.add_parser(
        "pangaea-bathymetry",
        help="import a PANGAEA point bathymetry table as actual depths",
    )
    generic_bathymetry.add_argument("--source-url", required=True)
    generic_bathymetry.add_argument("--input", required=True)
    generic_bathymetry.add_argument(
        "--depth-column-index", type=int, default=0
    )
    generic_bathymetry.add_argument("--commit", action="store_true")

    pangaea_overview = subparsers.add_parser(
        "pangaea-overview",
        help="fetch and import bathymetry TIFFs from a PANGAEA manifest",
    )
    pangaea_overview.add_argument("--dataset-id", required=True)
    pangaea_overview.add_argument("--manifest", type=Path)
    pangaea_overview.add_argument(
        "--cache-dir",
        type=Path,
        default=Path("/private/tmp/pangaea-soundings"),
    )
    pangaea_overview.add_argument("--commit", action="store_true")

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

    if args.command == "pangaea-ctd":
        payload = read_input(args.input)
        source_rows, endpoints = parse_pangaea_ctd_endpoints(payload)
        soundings = aggregate_ctd_endpoints(endpoints)
        print(
            f"{args.source_url}: {source_rows:,} CTD samples -> "
            f"{len(endpoints):,} profile endpoints -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: at_least (a CTD endpoint is not a bottom sounding).")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, count = import_pangaea_ctd(
                db, payload, args.source_url
            )
            db.commit()
            print(f"Stored {count:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    if args.command == "raster":
        cells, soundings = aggregate_rasters(args.input, args.depth_sign)
        print(
            f"{args.source_url}: {cells:,} measured raster cells -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: actual.")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, count = import_rasters(
                db,
                args.input,
                args.source_url,
                args.depth_sign,
            )
            db.commit()
            print(f"Stored {count:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    if args.command == "pangaea-bathymetry":
        payload = read_input(args.input)
        source_rows, soundings = aggregate_pangaea_bathymetry(
            payload, args.depth_column_index
        )
        print(
            f"{args.source_url}: {source_rows:,} measured depth points -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print(
            f"Depth kind: actual; bathymetry column index: "
            f"{args.depth_column_index}."
        )
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, count = import_pangaea_bathymetry(
                db,
                payload,
                args.source_url,
                args.depth_column_index,
            )
            db.commit()
            print(f"Stored {count:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    if args.command == "pangaea-overview":
        dataset_id = args.dataset_id
        if not dataset_id.isdigit():
            parser.error("--dataset-id must contain only digits")
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = (
            args.manifest
            if args.manifest is not None
            else args.cache_dir / f"PANGAEA.{dataset_id}.txt"
        )
        if args.manifest is None:
            download_with_run_curl(
                "https://doi.pangaea.de/10.1594/"
                f"PANGAEA.{dataset_id}?format=textfile",
                manifest_path,
            )
        payload = manifest_path.read_bytes()
        raster_paths = fetch_pangaea_bathymetry_files(
            payload, dataset_id, args.cache_dir
        )
        source_url = f"https://doi.org/10.1594/PANGAEA.{dataset_id}"
        cells, soundings = aggregate_rasters(raster_paths, "negative")
        print(
            f"{source_url}: {len(raster_paths):,} bathymetry files, "
            f"{cells:,} measured raster cells -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: actual.")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, count = import_rasters(
                db, raster_paths, source_url, "negative"
            )
            db.commit()
            print(f"Stored {count:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    point_sources = {
        "pangaea-770247": PANGAEA_770247_URL,
        "pangaea-935639": PANGAEA_935639_URL,
    }
    if args.command in point_sources:
        payload = read_input(args.input)
        source_rows, soundings = aggregate_pangaea_bathymetry(payload)
        print(
            f"{args.command}: {source_rows:,} bathymetry points -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: actual.")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, stored = import_pangaea_bathymetry(
                db, payload, point_sources[args.command]
            )
            db.commit()
            print(f"Stored {stored:,} rows in soundings.")
            print_status(db)
        finally:
            db.close()
        return 0

    if args.command == "pangaea-921991":
        payload = read_input(args.input)
        endpoints = parse_pangaea_ctd_bundle(payload)
        soundings = aggregate_ctd_endpoints(endpoints)
        print(
            f"PANGAEA 921991: {len(endpoints):,} CTD endpoints -> "
            f"{len(soundings):,} depth-12 tile checks"
        )
        print("Depth kind: at_least (a CTD endpoint is not a bottom sounding).")
        if not args.commit:
            print("DRY RUN — nothing changed. Re-run with --commit.")
            return 0
        db = open_db(str(args.db))
        try:
            _, stored = import_pangaea_921991(db, payload)
            db.commit()
            print(f"Stored {stored:,} rows in soundings.")
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

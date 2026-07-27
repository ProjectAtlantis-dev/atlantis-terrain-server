"""Ingest Asiaq Teknisk Grundkort road & path centerlines into terrain.db.

VEJMIDTE (road centerlines, with category + street name) and STIMIDTE (paths,
constructed vs nature trail) are PolyLineZ layers: every vertex carries a
surveyed surface elevation (GVR2016), which matches our DEM heights directly
(see ingest_buildings.py). Widths are not surveyed; they are assigned per
category here and can be tuned client-side later.

Usage:
    python ingest_roads.py <TekniskGrundkort_SHP.zip> [--db terrain.db]

Attribution: Contains data from Asiaq, Greenland Survey — Teknisk Grundkort.
"""

import argparse
import datetime
import json
import re
import struct
import sys
import time
import zipfile
from pathlib import Path

from pyproj import Transformer

from colored_log import get_logger
from ingest_buildings import read_dbf_records, source_epsg_from_prj

log = get_logger("terrain.roads")

ROADS_SCHEMA = """
CREATE TABLE IF NOT EXISTS roads (
    road_id    TEXT PRIMARY KEY,
    settlement TEXT NOT NULL,
    kind       TEXT NOT NULL,
    category   TEXT,
    name       TEXT,
    width_m    REAL NOT NULL,
    cx         REAL NOT NULL,
    cy         REAL NOT NULL,
    path       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roads_cxy ON roads(cx, cy);
"""

# Ribbon width per category, eyeballed against the Nuuk orthophoto.
ROAD_WIDTHS_M = {
    "Hovedvej": 8.0,
    "Lokalvej": 6.0,
    "Adgangsvej": 4.5,
    "Kørespor": 3.0,
    "Under anlæg": 5.0,
    "Tunnel": 6.0,
}
ROAD_DEFAULT_WIDTH_M = 5.0
PATH_WIDTHS_M = {
    "Anlagt": 2.0,
    "Natursti": 1.2,
}
PATH_DEFAULT_WIDTH_M = 1.5


def read_polylinez_parts(data):
    """Parse a PolyLineZ .shp; yield a list of parts per record (each part a
    list of (x, y, z)), or None for null/other-typed records."""
    filelen = struct.unpack(">i", data[24:28])[0] * 2
    pos = 100
    while pos < filelen:
        clen = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        content = data[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        rtype = struct.unpack("<i", content[:4])[0]
        if rtype != 13:
            yield None
            continue
        nparts, npoints = struct.unpack("<2i", content[36:44])
        off = 44
        parts = struct.unpack(f"<{nparts}i", content[off:off + 4 * nparts])
        off += 4 * nparts
        xy = struct.unpack(f"<{2 * npoints}d", content[off:off + 16 * npoints])
        off += 16 * npoints + 16  # skip z range
        zs = struct.unpack(f"<{npoints}d", content[off:off + 8 * npoints])
        bounds = list(parts) + [npoints]
        yield [
            [(xy[2 * i], xy[2 * i + 1], zs[i]) for i in range(bounds[p], bounds[p + 1])]
            for p in range(nparts)
        ]


def ingest_layer(db, archive, names, layer, kind, settlement, transformer, now):
    try:
        shp = archive.read(names[f"{layer}.SHP"])
        dbf = archive.read(names[f"{layer}.DBF"])
    except KeyError:
        log.warning(f"{settlement}: no {layer} layer in archive, skipping")
        return 0
    attrs = read_dbf_records(dbf)
    records = list(read_polylinez_parts(shp))
    widths = ROAD_WIDTHS_M if kind == "road" else PATH_WIDTHS_M
    default_width = ROAD_DEFAULT_WIDTH_M if kind == "road" else PATH_DEFAULT_WIDTH_M
    category_field = "vejkategor" if kind == "road" else "stitype"

    written = 0
    total = len(records)
    started = time.time()
    for index, parts in enumerate(records):
        if index % 250 == 0 and index > 0:
            elapsed = time.time() - started
            eta = elapsed / index * (total - index)
            log.info(f"{settlement} {layer}: {index}/{total} ({index * 100 // total}%) eta {eta:.0f}s")
            sys.stdout.flush()
        if not parts:
            continue
        attributes = attrs[index] if index < len(attrs) else {}
        raw_category = attributes.get(category_field)
        category = str(raw_category) if raw_category else None
        for part_index, part in enumerate(parts):
            if len(part) < 2:
                continue
            xs, ys, zs = zip(*part)
            tx, ty = transformer.transform(xs, ys)
            path = [
                [round(x, 2), round(y, 2), round(z, 2)]
                for x, y, z in zip(tx, ty, zs)
            ]
            road_id = f"{settlement}_{layer}_{attributes.get('lokal_id', '') or index}"
            if part_index:
                road_id += f"_p{part_index}"
            db.execute(
                "INSERT OR REPLACE INTO roads "
                "(road_id, settlement, kind, category, name, width_m, cx, cy, path, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    road_id, settlement, kind, category,
                    attributes.get("vejnavn") or None,
                    widths.get(category, default_width)
                    if category is not None else default_width,
                    sum(tx) / len(tx), sum(ty) / len(ty),
                    json.dumps(path), now,
                ),
            )
            written += 1
    log.info(f"{settlement} {layer}: wrote {written} polylines in {time.time() - started:.1f}s")
    return written


def ingest(zip_path, db_path):
    settlement_match = re.match(r"(\d{4}[A-Z]{3})", zip_path.name)
    if not settlement_match:
        log.error(f"cannot infer settlement code from filename: {zip_path.name}")
        return 1
    settlement = settlement_match.group(1)

    archive = zipfile.ZipFile(zip_path)
    names = {Path(n).name.upper(): n for n in archive.namelist()}
    try:
        prj = archive.read(names["VEJMIDTE.PRJ"]).decode("latin1")
    except KeyError:
        log.error("zip has no VEJMIDTE.prj — not a Teknisk Grundkort SHP archive?")
        return 1
    src_epsg = source_epsg_from_prj(prj)
    log.info(f"{settlement}: source CRS EPSG:{src_epsg} -> EPSG:3413")
    transformer = Transformer.from_crs(src_epsg, 3413, always_xy=True)

    import sqlite3
    db = sqlite3.connect(str(db_path))
    db.executescript(ROADS_SCHEMA)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    total = 0
    total += ingest_layer(db, archive, names, "VEJMIDTE", "road", settlement, transformer, now)
    total += ingest_layer(db, archive, names, "STIMIDTE", "path", settlement, transformer, now)
    db.commit()
    db.close()
    log.info(f"{settlement}: done, {total} polylines total")
    return 0


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("zip", type=Path, help="TekniskGrundkort SHP zip from kortforsyning.asiaq.gl")
    parser.add_argument("--db", type=Path, default=Path(__file__).parent / "terrain.db")
    args = parser.parse_args()
    if not args.zip.exists():
        log.error(f"no such file: {args.zip}")
        return 1
    return ingest(args.zip, args.db)


if __name__ == "__main__":
    sys.exit(main())

"""Ingest Asiaq Teknisk Grundkort line layers into assets.db.

The configured source layers are PolyLineZ layers: every vertex carries a
surveyed surface elevation (GVR2016), which matches our DEM heights directly
(see ingest_buildings.py). DBF attributes are stored verbatim under
``sourceProperties``; the importer does not interpret their classifications.

Usage:
    python ingest_roads.py <TekniskGrundkort_SHP.zip> \
        [--assets-db ../assetserver/assets.db]

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

DEFAULT_ASSETS_DB_PATH = Path(__file__).resolve().parent.parent / "assetserver" / "assets.db"
SOURCE_LAYERS = ("VEJMIDTE", "STIMIDTE")

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


def ingest_layer(db, archive, names, layer, settlement, transformer, now):
    from coords import to_wgs84
    try:
        shp = archive.read(names[f"{layer}.SHP"])
        dbf = archive.read(names[f"{layer}.DBF"])
    except KeyError:
        log.warning(f"{settlement}: no {layer} layer in archive, skipping")
        return 0
    attrs = read_dbf_records(dbf)
    records = list(read_polylinez_parts(shp))
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
            cx, cy = sum(tx) / len(tx), sum(ty) / len(ty)
            lat, lon = to_wgs84(cx, cy)
            properties = json.dumps({
                "sourceLayer": layer,
                "sourceProperties": attributes,
                "path": path,
            }, ensure_ascii=False, separators=(",", ":"))
            db.execute(
                "INSERT INTO assets "
                "(id,type,enabled,lat,lon,heading_deg,z,properties,cx,cy,"
                "min_x,min_y,max_x,max_y,updated_at) "
                "VALUES (?,?,1,?,?,0,NULL,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET type=excluded.type,lat=excluded.lat,"
                "lon=excluded.lon,properties=excluded.properties,cx=excluded.cx,"
                "cy=excluded.cy,min_x=excluded.min_x,min_y=excluded.min_y,"
                "max_x=excluded.max_x,max_y=excluded.max_y,updated_at=excluded.updated_at",
                (
                    road_id, layer, float(lat), float(lon), properties, cx, cy,
                    min(tx), min(ty), max(tx), max(ty), now,
                ),
            )
            written += 1
    log.info(f"{settlement} {layer}: wrote {written} polylines in {time.time() - started:.1f}s")
    return written


def ingest(zip_path, assets_db_path=DEFAULT_ASSETS_DB_PATH):
    settlement_match = re.match(r"(\d{4}[A-Z]{3})", zip_path.name)
    if not settlement_match:
        log.error(f"cannot infer settlement code from filename: {zip_path.name}")
        return 1
    settlement = settlement_match.group(1)

    archive = zipfile.ZipFile(zip_path)
    names = {Path(n).name.upper(): n for n in archive.namelist()}
    try:
        prj = archive.read(names[f"{SOURCE_LAYERS[0]}.PRJ"]).decode("latin1")
    except KeyError:
        log.error(
            f"zip has no {SOURCE_LAYERS[0]}.prj — "
            "not a Teknisk Grundkort SHP archive?"
        )
        return 1
    src_epsg = source_epsg_from_prj(prj)
    log.info(f"{settlement}: source CRS EPSG:{src_epsg} -> EPSG:3413")
    transformer = Transformer.from_crs(src_epsg, 3413, always_xy=True)

    from asset_catalog import connect
    db = connect(Path(assets_db_path))
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    total = 0
    for layer in SOURCE_LAYERS:
        total += ingest_layer(db, archive, names, layer, settlement, transformer, now)
    db.commit()
    db.close()
    log.info(f"{settlement}: done, {total} polylines total")
    return 0


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("zip", type=Path, help="TekniskGrundkort SHP zip from kortforsyning.asiaq.gl")
    parser.add_argument("--assets-db", type=Path, default=DEFAULT_ASSETS_DB_PATH)
    args = parser.parse_args()
    if not args.zip.exists():
        log.error(f"no such file: {args.zip}")
        return 1
    return ingest(args.zip, args.assets_db)


if __name__ == "__main__":
    sys.exit(main())

"""Ingest an Asiaq Teknisk Grundkort building layer into assets.db.

Buildings come from Asiaq's settlement base maps (kortforsyning.asiaq.gl) as
ESRI PolygonZ shapefiles: the outline is traced at the roof overhang and every
vertex carries a surveyed roof elevation (GVR2016). Empirically GVR2016 and our
ArcticDEM-derived heights agree to within noise at Nuuk, so roof Z is used
directly against ground sampled from the tiles table — no datum shift.

Usage:
    python ingest_buildings.py <TekniskGrundkort_SHP.zip> \
        [--terrain-db terrain.db] [--assets-db ../assetserver/assets.db]

The settlement code (e.g. 0600NUK) is taken from the zip filename. The source
The UTM zone is read from the source layer's PRJ file (GR96 zones 18N-24N =
EPSG:3178-3184).

Attribution: Contains data from Asiaq, Greenland Survey — Teknisk Grundkort.
Terms: https://www.asiaq.gl/wp-content/uploads/2026/04/EN_Terms_of_use_for_Asiaq_geodata.pdf
"""

import argparse
import datetime
import json
import re
import struct
import sys
import time
import zipfile
import zlib
from pathlib import Path

import numpy as np
from pyproj import Transformer

from colored_log import get_logger
from terrain_config import GREENLAND_BBOX

log = get_logger("terrain.buildings")

DEFAULT_ASSETS_DB_PATH = Path(__file__).resolve().parent.parent / "assetserver" / "assets.db"
SOURCE_LAYER = "BYGNING"


def _decode_dbf_text(raw):
    # Asiaq DBFs ship with a UTF-8 .cpg; fall back to latin1 for odd bytes.
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin1")


def read_dbf_records(data):
    """Parse DBF bytes into a list of dicts (UTF-8 with latin1 fallback)."""
    nrec = struct.unpack("<I", data[4:8])[0]
    hdrlen = struct.unpack("<H", data[8:10])[0]
    nfields = (hdrlen - 33) // 32
    fields = []
    for i in range(nfields):
        fd = data[32 + i * 32:64 + i * 32]
        name = fd[:11].split(b"\x00")[0].decode("latin1")
        fields.append((name, fd[16]))
    reclen = sum(flen for _, flen in fields) + 1
    records = []
    for i in range(nrec):
        rec = data[hdrlen + i * reclen:hdrlen + (i + 1) * reclen]
        pos = 1
        row = {}
        for name, flen in fields:
            row[name] = _decode_dbf_text(rec[pos:pos + flen]).strip()
            pos += flen
        records.append(row)
    return records


def read_polygonz_outer_rings(data):
    """Parse a PolygonZ .shp; yield the outer ring of each record as
    a list of (x, y, z) tuples, or None for null/non-PolygonZ records."""
    filelen = struct.unpack(">i", data[24:28])[0] * 2
    pos = 100
    while pos < filelen:
        clen = struct.unpack(">i", data[pos + 4:pos + 8])[0] * 2
        content = data[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        rtype = struct.unpack("<i", content[:4])[0]
        if rtype != 15:
            yield None
            continue
        nparts, npoints = struct.unpack("<2i", content[36:44])
        off = 44
        parts = struct.unpack(f"<{nparts}i", content[off:off + 4 * nparts])
        off += 4 * nparts
        xy = struct.unpack(f"<{2 * npoints}d", content[off:off + 16 * npoints])
        off += 16 * npoints + 16  # skip z range
        zs = struct.unpack(f"<{npoints}d", content[off:off + 8 * npoints])
        end = parts[1] if nparts > 1 else npoints
        ring = [(xy[2 * i], xy[2 * i + 1], zs[i]) for i in range(parts[0], end)]
        yield ring


def source_epsg_from_prj(prj_text):
    """GR96 UTM zone NN N -> EPSG:3160+NN (zones 18-24 = 3178-3184)."""
    match = re.search(r"UTM[_ ]Zone[_ ](\d+)N", prj_text, re.IGNORECASE)
    if not match:
        raise ValueError(f"cannot find UTM zone in .prj: {prj_text[:120]}")
    zone = int(match.group(1))
    if not 18 <= zone <= 24:
        raise ValueError(f"unexpected GR96 UTM zone {zone}")
    return 3160 + zone


class GroundSampler:
    """Sample ground elevation from the deepest cached heightmap tile.

    Tiles are addressed, not scanned. The tile grid is a regular quadtree over
    ``GREENLAND_BBOX``, so a point maps to exactly one ``(col, row)`` at each
    depth and the deepest covering tile can be found with one dict lookup per
    depth. The previous linear scan over every heightmap tile cost 34M bbox
    tests per /api/tiles request (1226 buildings x 28039 tiles).

    ``bbox`` restricts the loaded tile set to a region of interest. Callers
    that sample a bounded area (the building query) should pass it; the
    ingest path samples arbitrary points and leaves it None.
    """

    def __init__(self, db, bbox=None, index=None, cache=None):
        """``index`` and ``cache`` let callers share the expensive parts.

        The tile index and the decompressed heightmaps are immutable and
        connection-independent, so they can be reused across requests. The
        connection cannot: it belongs to one request and is closed when that
        request ends. Sharing a whole sampler and rebinding ``db`` on it races
        two concurrent requests into operating on a closed connection, so each
        request gets its own instance over the shared data instead.
        """
        self.db = db
        self.cache = {} if cache is None else cache
        if index is not None:
            self._by_depth, self._depths = index
            return

        sql = (
            "SELECT tile_id, depth, col, row, x_min, y_min, x_max, y_max "
            "FROM tiles WHERE heightmap IS NOT NULL"
        )
        params: tuple = ()
        if bbox is not None:
            sql += " AND x_max > ? AND x_min < ? AND y_max > ? AND y_min < ?"
            params = (bbox[0], bbox[2], bbox[1], bbox[3])
        self._by_depth: dict[int, dict[tuple[int, int], tuple]] = {}
        for tile_id, depth, col, row, x0, y0, x1, y1 in db.execute(sql, params):
            self._by_depth.setdefault(depth, {})[(col, row)] = (
                tile_id, x0, y0, x1, y1,
            )
        # Deepest first: the finest tile covering a point wins, as before.
        self._depths = sorted(self._by_depth, reverse=True)

    @property
    def index(self):
        """The connection-independent tile index, safe to share."""
        return (self._by_depth, self._depths)

    def sample(self, x, y):
        rx_min, ry_min, rx_max, ry_max = GREENLAND_BBOX
        span_x = rx_max - rx_min
        span_y = ry_max - ry_min
        for depth in self._depths:
            n_tiles = 1 << depth
            col = int((x - rx_min) / span_x * n_tiles)
            row = int((y - ry_min) / span_y * n_tiles)
            entry = self._by_depth[depth].get((col, row))
            if entry is None:
                continue
            tile_id, x_min, y_min, x_max, y_max = entry
            # The stored bbox stays authoritative for interpolation, so a tile
            # whose extent disagrees with the addressing still samples right.
            if not (x_min <= x < x_max and y_min <= y < y_max):
                continue
            hm = self.cache.get(tile_id)
            if hm is None:
                blob = self.db.execute(
                    "SELECT heightmap FROM tiles WHERE tile_id = ?", (tile_id,)
                ).fetchone()[0]
                arr = np.frombuffer(zlib.decompress(blob), dtype=np.float32)
                n = int(round(len(arr) ** 0.5))
                hm = self.cache[tile_id] = arr.reshape(n, n)
            n = hm.shape[0]
            col_px = int((x - x_min) / (x_max - x_min) * (n - 1))
            row_px = int((y - y_min) / (y_max - y_min) * (n - 1))  # row 0 = south
            value = float(hm[row_px, col_px])
            if np.isnan(value):
                continue
            return value
        return None


def ingest(zip_path, terrain_db_path, assets_db_path=DEFAULT_ASSETS_DB_PATH):
    settlement_match = re.match(r"(\d{4}[A-Z]{3})", zip_path.name)
    if not settlement_match:
        log.error(f"cannot infer settlement code from filename: {zip_path.name}")
        return 1
    settlement = settlement_match.group(1)

    archive = zipfile.ZipFile(zip_path)
    names = {Path(n).name.upper(): n for n in archive.namelist()}
    try:
        shp = archive.read(names[f"{SOURCE_LAYER}.SHP"])
        dbf = archive.read(names[f"{SOURCE_LAYER}.DBF"])
        prj = archive.read(names[f"{SOURCE_LAYER}.PRJ"]).decode("latin1")
    except KeyError as exc:
        log.error(f"zip is missing {exc} — not a Teknisk Grundkort SHP archive?")
        return 1

    src_epsg = source_epsg_from_prj(prj)
    log.info(f"{settlement}: source CRS EPSG:{src_epsg} -> EPSG:3413")
    transformer = Transformer.from_crs(src_epsg, 3413, always_xy=True)

    attrs = read_dbf_records(dbf)
    rings = list(read_polygonz_outer_rings(shp))
    if len(attrs) != len(rings):
        log.warning(f"attribute/shape count mismatch: {len(attrs)} vs {len(rings)}")

    import sqlite3
    from asset_catalog import connect
    from coords import to_wgs84

    terrain_db = sqlite3.connect(str(terrain_db_path))
    sampler = GroundSampler(terrain_db)
    assets_db = connect(Path(assets_db_path))
    id_prefix = f"{settlement}_"
    enabled_by_id = dict(assets_db.execute(
        "SELECT id,enabled FROM assets WHERE type=? AND substr(id,1,?)=?",
        (SOURCE_LAYER, len(id_prefix), id_prefix),
    ))
    # The source archive is a complete settlement snapshot. Replace this
    # layer in one transaction so features removed upstream do not survive a
    # refresh, while retaining local visibility choices for stable IDs.
    assets_db.execute(
        "DELETE FROM assets WHERE type=? AND substr(id,1,?)=?",
        (SOURCE_LAYER, len(id_prefix), id_prefix),
    )
    if not sampler.tiles:
        log.warning("tiles table has no heightmaps — ground will fall back to roof-derived estimate")

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    total = len(rings)
    written = skipped = no_ground = 0
    started = time.time()
    for index, ring in enumerate(rings):
        if index % 250 == 0 and index > 0:
            elapsed = time.time() - started
            eta = elapsed / index * (total - index)
            log.info(f"{settlement}: {index}/{total} ({index * 100 // total}%) eta {eta:.0f}s")
            sys.stdout.flush()
        if not ring or len(ring) < 3:
            skipped += 1
            continue
        # Drop the duplicated closing vertex if present.
        if ring[0][:2] == ring[-1][:2]:
            ring = ring[:-1]
        if len(ring) < 3:
            skipped += 1
            continue
        xs, ys, zs = zip(*ring)
        tx, ty = transformer.transform(xs, ys)
        cx = sum(tx) / len(tx)
        cy = sum(ty) / len(ty)
        roof_min = min(zs)
        ground = sampler.sample(cx, cy)
        ground_sampled = ground is not None
        if ground is None:
            ground = roof_min - 3.0
            no_ground += 1
        # A roof surveyed below the sampled ground means DEM noise on a slope;
        # keep the building visible by dropping the base below the roof.
        ground = min(ground, roof_min - 0.5)
        attributes = attrs[index] if index < len(attrs) else {}
        building_id = f"{settlement}_{attributes.get('lokal_id', '') or index}"
        ring_3413 = [
            [round(x, 2), round(y, 2), round(z, 2)]
            for x, y, z in zip(tx, ty, zs)
        ]
        lat, lon = to_wgs84(cx, cy)
        properties = json.dumps({
            "sourceLayer": SOURCE_LAYER,
            "sourceProperties": attributes,
            "groundZ": round(ground, 2),
            "groundSampled": ground_sampled,
            "ring": ring_3413,
        }, ensure_ascii=False, separators=(",", ":"))
        assets_db.execute(
            "INSERT INTO assets "
            "(id,type,enabled,lat,lon,heading_deg,z,properties,cx,cy,"
            "min_x,min_y,max_x,max_y,updated_at) "
            "VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET type=excluded.type,lat=excluded.lat,"
            "lon=excluded.lon,z=excluded.z,properties=excluded.properties,"
            "cx=excluded.cx,cy=excluded.cy,min_x=excluded.min_x,min_y=excluded.min_y,"
            "max_x=excluded.max_x,max_y=excluded.max_y,updated_at=excluded.updated_at",
            (
                building_id, SOURCE_LAYER, enabled_by_id.get(building_id, 1),
                float(lat), float(lon), round(ground, 2), properties,
                cx, cy, min(tx), min(ty), max(tx), max(ty), now,
            ),
        )
        written += 1
    assets_db.commit()
    log.info(
        f"{settlement}: wrote {written} buildings "
        f"({skipped} skipped, {no_ground} without heightmap ground) "
        f"in {time.time() - started:.1f}s"
    )
    assets_db.close()
    terrain_db.close()
    return 0


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("zip", type=Path, help="TekniskGrundkort SHP zip from kortforsyning.asiaq.gl")
    parser.add_argument("--terrain-db", type=Path, default=Path(__file__).parent / "terrain.db")
    parser.add_argument("--assets-db", type=Path, default=DEFAULT_ASSETS_DB_PATH)
    args = parser.parse_args()
    if not args.zip.exists():
        log.error(f"no such file: {args.zip}")
        return 1
    return ingest(args.zip, args.terrain_db, args.assets_db)


if __name__ == "__main__":
    sys.exit(main())

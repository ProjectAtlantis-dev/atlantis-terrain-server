import io
import os
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from database import open_db
from ingest_depth_evidence import (
    PANGAEA_770247_URL,
    PANGAEA_921991_URL,
    PANGAEA_933610_URL,
    PANGAEA_992416_URL,
    import_pangaea_921991,
    import_pangaea_933610,
    import_pangaea_992416,
    import_pangaea_bathymetry,
    import_pangaea_ctd,
    import_rasters,
    parse_pangaea_bathymetry_files,
    parse_pangaea_ctd_bundle,
    parse_pangaea_ctd_endpoints,
)


PANGAEA_FIXTURE = b"""/* DATA DESCRIPTION:
License:\tCreative Commons Attribution 4.0 International
*/
Event\tDate/Time\tStation\tLatitude\tLongitude\tDepth water [m]\tTemp [\xc2\xb0C]\tSal
Ameralik_AM1\t2019-05-05\tAM1\t64.0812\t-51.7474\t1\t0.7\t33
Ameralik_AM1\t2019-05-05\tAM1\t64.0812\t-51.7474\t50\t0.8\t34
Ameralik_AM1\t2019-09-09\tAM1\t64.0795\t-51.7512\t42\t1.0\t34
Godthabsfjord_GF1\t2019-05-01\tGF1\t64.0505\t-52.1820\t27\t1.1\t34
"""

PANGAEA_BATHYMETRY_FIXTURE = b"""/* DATA DESCRIPTION:
License:\tCreative Commons Attribution 4.0 International
*/
Latitude\tLongitude\tBathy depth interp/grid [m]
69.350000\t-51.547687\t100
69.350000\t-51.547183\t200
69.340000\t-51.200000\t300
"""

PANGAEA_MULTI_DEPTH_FIXTURE = b"""/* DATA DESCRIPTION:
*/
Latitude\tLongitude\tBathy depth [m] (Multibeam)\tBathy depth [m] (Echo)
75.0\t-12.0\t400\t390
75.1\t-12.1\t500\t480
"""

PANGAEA_FILE_MANIFEST_FIXTURE = b"""/* DATA DESCRIPTION:
*/
Binary\tBinary (Type)\tContent
day-1.xyz\ttext/plain\tLongitude, Latitude, Elevation
day-1.tif\timage/tiff\tOverview raster of bathymetric data
day-1_num.tif\timage/tiff\tNumber of soundings
day-1_sd.tif\timage/tiff\tStandard deviation of bathymetry
backscatter.tif\timage/tiff\tMultibeam backscatter grid
"""

PANGAEA_EVENT_POSITION_FIXTURE = b"""/* DATA DESCRIPTION:
Event(s):\tEast-1 * LATITUDE: 74.2376 * LONGITUDE: -20.1884
\tEast-2 * LATITUDE: 74.3552 * LONGITUDE: -20.5680
*/
Event\tDepth water [m]\tTemp
East-1\t5\t2
East-1\t40\t1
East-2\t10\t2
East-2\t336\t1
"""

PANGAEA_STATION_FIXTURE = b"""/* DATA DESCRIPTION:
*/
Station\tLatitude\tLongitude\tDepth water [m]
SF-1\t65.8178\t-37.9558\t10
SF-1\t65.8178\t-37.9558\t800
"""


def ctd_bundle_fixture():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "datasets/station-a.tab",
            """/* DATA DESCRIPTION:
Coverage:\tLATITUDE: 64.3372 * LONGITUDE: -49.7187
*/
Depth water [m]\tTemp
1\t2
626\t1
""",
        )
        archive.writestr(
            "datasets/station-b.tab",
            """/* DATA DESCRIPTION:
Coverage:\tLATITUDE: 70.4773 * LONGITUDE: -51.6688
*/
Depth water [m]\tTemp
1\t2
410\t1
""",
        )
    return buffer.getvalue()


class DepthEvidenceTest(unittest.TestCase):
    def test_parser_keeps_repeated_casts_and_only_the_endpoint(self):
        source_rows, soundings = parse_pangaea_ctd_endpoints(PANGAEA_FIXTURE)
        self.assertEqual(source_rows, 4)
        self.assertEqual(len(soundings), 3)
        self.assertEqual(
            sorted(row["depth_m"] for row in soundings),
            [27.0, 42.0, 50.0],
        )

    def test_import_stores_only_sourced_lower_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            result = import_pangaea_933610(db, PANGAEA_FIXTURE)
            db.commit()

            self.assertEqual(result, (4, 2))
            self.assertEqual(
                db.execute(
                    "SELECT DISTINCT source_url, depth_kind FROM soundings"
                ).fetchall(),
                [(PANGAEA_933610_URL, "at_least")],
            )
            self.assertEqual(
                sorted(row[0] for row in db.execute("SELECT depth_m FROM soundings")),
                [27.0, 50.0],
            )
            self.assertTrue(
                db.execute(
                    "SELECT MIN(created_at) <> '' FROM soundings"
                ).fetchone()[0]
            )
            db.close()

    def test_ctd_parser_uses_event_metadata_positions_when_rows_omit_them(self):
        source_rows, endpoints = parse_pangaea_ctd_endpoints(
            PANGAEA_EVENT_POSITION_FIXTURE
        )
        self.assertEqual(source_rows, 4)
        self.assertEqual(
            [(row["latitude"], row["longitude"], row["depth_m"])
             for row in endpoints],
            [
                (74.2376, -20.1884, 40.0),
                (74.3552, -20.5680, 336.0),
            ],
        )

        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(
                import_pangaea_ctd(
                    db,
                    PANGAEA_EVENT_POSITION_FIXTURE,
                    "https://doi.org/10.1594/PANGAEA.example",
                ),
                (4, 2),
            )
            self.assertEqual(
                db.execute(
                    "SELECT DISTINCT depth_kind FROM soundings"
                ).fetchall(),
                [("at_least",)],
            )
            db.close()

    def test_ctd_parser_accepts_station_as_profile_identity(self):
        source_rows, endpoints = parse_pangaea_ctd_endpoints(
            PANGAEA_STATION_FIXTURE
        )
        self.assertEqual(source_rows, 2)
        self.assertEqual(
            endpoints,
            [{
                "record_id": "SF-1",
                "latitude": 65.8178,
                "longitude": -37.9558,
                "depth_m": 800.0,
            }],
        )

    def test_depth_kind_is_constrained_by_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            import_pangaea_933610(db, PANGAEA_FIXTURE)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE soundings SET depth_kind = 'probably'")
            db.close()

    def test_multibeam_grid_stores_only_underwater_cells_as_actual(self):
        with tempfile.TemporaryDirectory() as directory:
            raster_path = Path(directory) / "bathymetry.tif"
            with rasterio.open(
                raster_path,
                "w",
                driver="GTiff",
                width=2,
                height=2,
                count=1,
                dtype="float32",
                crs="EPSG:32622",
                transform=from_origin(500000, 7160000, 50, 50),
                nodata=-9999,
            ) as raster:
                raster.write(
                    np.array([[-12.5, 2.0], [-9999, -47.0]], dtype=np.float32),
                    1,
                )

            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(import_pangaea_992416(db, raster_path), (2, 1))
            self.assertEqual(
                db.execute(
                    "SELECT source_url, depth_kind, COUNT(*), "
                    "MIN(depth_m), MAX(depth_m) FROM soundings"
                ).fetchone(),
                (PANGAEA_992416_URL, "actual", 1, 29.75, 29.75),
            )
            db.close()

    def test_generic_raster_accepts_unprojected_lon_lat_grid(self):
        with tempfile.TemporaryDirectory() as directory:
            raster_path = Path(directory) / "gmt-style.grd"
            with rasterio.open(
                raster_path,
                "w",
                driver="GTiff",
                width=2,
                height=1,
                count=1,
                dtype="float32",
                transform=from_origin(-41.42, 63.21, 0.001, 0.001),
                nodata=np.nan,
            ) as raster:
                raster.write(
                    np.array([[-20.0, -40.0]], dtype=np.float32),
                    1,
                )

            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(
                import_rasters(
                    db,
                    [raster_path],
                    "https://doi.org/10.1594/PANGAEA.test-raster",
                    "negative",
                ),
                (2, 1),
            )
            self.assertEqual(
                db.execute(
                    "SELECT depth_kind, depth_m FROM soundings"
                ).fetchone(),
                ("actual", 30.0),
            )
            db.close()

    def test_pangaea_manifest_selects_only_bathymetry_tiffs(self):
        self.assertEqual(
            parse_pangaea_bathymetry_files(
                PANGAEA_FILE_MANIFEST_FIXTURE, "123456"
            ),
            [(
                "day-1.tif",
                "https://download.pangaea.de/dataset/123456/files/day-1.tif",
            )],
        )

    def test_tabular_bathymetry_is_averaged_by_depth_12_tile(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(
                import_pangaea_bathymetry(
                    db, PANGAEA_BATHYMETRY_FIXTURE, PANGAEA_770247_URL
                ),
                (3, 2),
            )
            self.assertEqual(
                db.execute(
                    "SELECT source_url, depth_kind, COUNT(*), "
                    "MIN(depth_m), MAX(depth_m) FROM soundings"
                ).fetchone(),
                (PANGAEA_770247_URL, "actual", 2, 150.0, 300.0),
            )
            db.close()

    def test_tabular_bathymetry_selects_explicit_depth_column(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            source_url = "https://doi.org/10.1594/PANGAEA.multi-depth"
            self.assertEqual(
                import_pangaea_bathymetry(
                    db,
                    PANGAEA_MULTI_DEPTH_FIXTURE,
                    source_url,
                    depth_column_index=1,
                )[0],
                2,
            )
            self.assertEqual(
                [
                    row[0]
                    for row in db.execute(
                        "SELECT depth_m FROM soundings ORDER BY depth_m"
                    )
                ],
                [390.0, 480.0],
            )
            db.close()

    def test_ctd_bundle_stores_endpoints_as_lower_bounds(self):
        payload = ctd_bundle_fixture()
        endpoints = parse_pangaea_ctd_bundle(payload)
        self.assertEqual(
            sorted(row["depth_m"] for row in endpoints),
            [410.0, 626.0],
        )
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            self.assertEqual(import_pangaea_921991(db, payload), (2, 2))
            self.assertEqual(
                db.execute(
                    "SELECT source_url, depth_kind, COUNT(*) FROM soundings"
                ).fetchone(),
                (PANGAEA_921991_URL, "at_least", 2),
            )
            db.close()

    def test_schema_v9_has_one_depth_evidence_table(self):
        with tempfile.TemporaryDirectory() as directory:
            db = open_db(str(Path(directory) / "terrain.db"))
            tables = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            self.assertIn("soundings", tables)
            self.assertTrue(
                {
                    "depth_sources",
                    "depth_observations",
                    "depth_assets",
                    "depth_imports",
                }.isdisjoint(tables)
            )
            self.assertEqual(
                db.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone(),
                ("9",),
            )
            db.close()


if __name__ == "__main__":
    unittest.main()

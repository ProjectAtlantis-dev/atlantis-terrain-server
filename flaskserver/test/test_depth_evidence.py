import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

from database import open_db
from ingest_depth_evidence import (
    PANGAEA_933610_URL,
    PANGAEA_992416_URL,
    import_pangaea_933610,
    import_pangaea_992416,
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

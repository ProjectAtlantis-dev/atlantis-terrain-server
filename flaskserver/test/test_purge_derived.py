import sqlite3
import unittest

from purge_derived import apply_derived_purge, plan_derived_purge


def _db():
    db = sqlite3.connect(":memory:")
    db.executescript(
        """
        CREATE TABLE tiles (
            tile_id TEXT PRIMARY KEY, source TEXT, heightmap BLOB,
            confidence_map BLOB, geometric_error REAL, updated_at TEXT,
            dem_demanded_at TEXT, dem_requested_at TEXT, cog_requested_at TEXT
        );
        CREATE TABLE textures (
            tile_id TEXT PRIMARY KEY, source TEXT, texture BLOB
        );
        CREATE TABLE coastline_masks (tile_id TEXT PRIMARY KEY);
        CREATE TABLE hydrography_masks (tile_id TEXT PRIMARY KEY, source TEXT);
        CREATE TABLE classifier_tiles (tile_id TEXT PRIMARY KEY);
        CREATE TABLE road_texture_bakes (tile_id TEXT PRIMARY KEY);
        CREATE TABLE cliff_graft_assets (donor_tile_id TEXT PRIMARY KEY);
        CREATE TABLE terrain_seam_cache (
            tile_a TEXT, direction TEXT, tile_b TEXT,
            PRIMARY KEY (tile_a, direction, tile_b)
        );
        CREATE TABLE bathymetry (tile_id TEXT PRIMARY KEY, source TEXT);
        CREATE TABLE water_purge_audit (tile_id TEXT PRIMARY KEY);
        CREATE TABLE roads (road_id TEXT PRIMARY KEY);
        CREATE TABLE buildings (building_id TEXT PRIMARY KEY);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE soundings (
            source_url TEXT, record_id TEXT, depth_m REAL,
            evidence_sw_m REAL, evidence_se_m REAL,
            modeled_depth_m REAL, model_delta_m REAL, model_error_m REAL,
            model_health TEXT, model_tile_id TEXT, model_source TEXT,
            model_version INTEGER, model_updated_at TEXT, compared_at TEXT,
            modeled_sw_m REAL, modeled_se_m REAL,
            modeled_nw_m REAL, modeled_ne_m REAL,
            model_sample_count INTEGER, model_signature TEXT,
            comparison_revision INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source_url, record_id)
        );
        CREATE TRIGGER bathymetry_invalidates_seams
        AFTER DELETE ON bathymetry BEGIN DELETE FROM terrain_seam_cache; END;
        """
    )
    return db


def _seed(db, *, reverse=False):
    statements = [
        ("INSERT INTO tiles VALUES (?,?,?,?,?,?,?,?,?)", (
            "12-1-1", "arcticdem_10m", b"measured", b"confidence", 4.0,
            "origin-time", "d", "r", "c",
        )),
        ("INSERT INTO tiles VALUES (?,?,?,?,?,?,?,?,?)", (
            "13-2-2", "cooked_dem", b"cooked", b"confidence", 8.0,
            "derived-time", "d", "r", "c",
        )),
        ("INSERT INTO tiles VALUES (?,?,?,?,?,?,?,?,?)", (
            "12-1-2", "official_coastline", b"flat-ocean", None, 0.0,
            "derived-time", None, None, None,
        )),
        ("INSERT INTO textures VALUES (?,?,?)", (
            "12-1-1", "dataforsyningen_metatile4h2", b"provider",
        )),
        ("INSERT INTO textures VALUES (?,?,?)", (
            "12-1-2", "ancestor_crop_nodata", b"no-coverage-fallback",
        )),
        ("INSERT INTO textures VALUES (?,?,?)", (
            "13-2-2", "cooked_upscale", b"cooked-texture",
        )),
    ]
    for sql, params in reversed(statements) if reverse else statements:
        db.execute(sql, params)
    for table, column, value in (
        ("coastline_masks", "tile_id", "12-1-1"),
        ("hydrography_masks", "tile_id", "12-1-1"),
        ("classifier_tiles", "tile_id", "12-1-1"),
        ("road_texture_bakes", "tile_id", "12-1-1"),
        ("cliff_graft_assets", "donor_tile_id", "12-1-1"),
        ("bathymetry", "tile_id", "8-0-0"),
        ("water_purge_audit", "tile_id", "13-2-2"),
    ):
        if table in {"hydrography_masks", "bathymetry"}:
            db.execute(
                f"INSERT INTO {table} ({column}, source) VALUES (?, ?)",
                (value, "upstream" if table == "hydrography_masks" else "carve_v1"),
            )
        else:
            db.execute(f"INSERT INTO {table} ({column}) VALUES (?)", (value,))
    db.execute(
        "INSERT INTO terrain_seam_cache VALUES ('12-1-1','east','12-1-2')"
    )
    db.execute("INSERT INTO roads VALUES ('road-origin')")
    db.execute("INSERT INTO buildings VALUES ('building-origin')")
    db.execute("INSERT INTO metadata VALUES ('schema_version','18')")
    db.execute(
        "INSERT INTO metadata VALUES "
        "('bathymetry_demand_failure:8-0-0','retry-state')"
    )
    db.execute(
        "INSERT INTO soundings "
        "(source_url,record_id,depth_m,evidence_sw_m,evidence_se_m,"
        "modeled_depth_m,model_delta_m,model_error_m,model_health,model_tile_id,"
        "model_source,model_version,model_updated_at,compared_at,modeled_sw_m,"
        "modeled_se_m,modeled_nw_m,modeled_ne_m,model_sample_count,"
        "model_signature,comparison_revision) "
        "VALUES ('survey','cast-1',42,41,43,-40,2,2,'red','8-0-0',"
        "'carve_v1',1,'model-time','compare-time',-39,-41,-40,-42,4,'sig',7)"
    )
    db.commit()


def _snapshot(db):
    return {
        table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
        for table in (
            "tiles", "textures", "coastline_masks", "hydrography_masks",
            "classifier_tiles", "road_texture_bakes", "cliff_graft_assets",
            "terrain_seam_cache", "bathymetry", "water_purge_audit", "roads",
            "buildings", "metadata", "soundings",
        )
    }


class GlobalDerivedPurgeTests(unittest.TestCase):
    def test_preview_is_read_only_and_global(self):
        db = _db()
        self.addCleanup(db.close)
        _seed(db)
        before = _snapshot(db)

        counts = plan_derived_purge(db)

        self.assertEqual(counts["tiles (derived -> pending)"], 2)
        self.assertEqual(counts["textures (derived)"], 1)
        self.assertEqual(counts["coastline_masks"], 1)
        self.assertEqual(counts["bathymetry"], 1)
        self.assertEqual(_snapshot(db), before)

    def test_apply_removes_derivatives_and_preserves_origins(self):
        db = _db()
        self.addCleanup(db.close)
        _seed(db)

        apply_derived_purge(db)

        measured = db.execute(
            "SELECT source,heightmap,confidence_map,geometric_error,updated_at "
            "FROM tiles WHERE tile_id='12-1-1'"
        ).fetchone()
        self.assertEqual(
            measured,
            ("arcticdem_10m", b"measured", b"confidence", 4.0, "origin-time"),
        )
        reset = db.execute(
            "SELECT tile_id,source,heightmap,confidence_map,geometric_error "
            "FROM tiles WHERE tile_id IN ('13-2-2','12-1-2') ORDER BY tile_id"
        ).fetchall()
        self.assertEqual(
            reset,
            [("12-1-2", "pending", None, None, 0.0),
             ("13-2-2", "pending", None, None, 0.0)],
        )
        self.assertEqual(
            db.execute("SELECT tile_id,source FROM textures ORDER BY tile_id").fetchall(),
            [("12-1-1", "dataforsyningen_metatile4h2"),
             ("12-1-2", "ancestor_crop_nodata")],
        )
        for table in (
            "coastline_masks", "classifier_tiles", "road_texture_bakes",
            "cliff_graft_assets", "terrain_seam_cache", "bathymetry",
            "water_purge_audit",
        ):
            self.assertEqual(
                db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0, table,
            )
        # Downloaded WMS evidence and non-tile origins survive.
        self.assertEqual(db.execute("SELECT COUNT(*) FROM hydrography_masks").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM roads").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM buildings").fetchone()[0], 1)
        self.assertEqual(
            db.execute("SELECT depth_m,evidence_sw_m,evidence_se_m FROM soundings").fetchone(),
            (42.0, 41.0, 43.0),
        )
        modeled = db.execute(
            "SELECT modeled_depth_m,model_health,model_tile_id,model_signature,"
            "comparison_revision FROM soundings"
        ).fetchone()
        self.assertEqual(modeled, (None, "white", None, None, 8))
        self.assertEqual(
            db.execute("SELECT key FROM metadata ORDER BY key").fetchall(),
            [("schema_version",)],
        )

    def test_second_apply_is_a_noop(self):
        db = _db()
        self.addCleanup(db.close)
        _seed(db)
        apply_derived_purge(db)
        first = _snapshot(db)

        applied = apply_derived_purge(db)

        self.assertTrue(all(count == 0 for count in applied.values()))
        self.assertEqual(_snapshot(db), first)

    def test_arrival_order_does_not_change_the_canonical_reset(self):
        left, right = _db(), _db()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        _seed(left, reverse=False)
        _seed(right, reverse=True)

        apply_derived_purge(left)
        apply_derived_purge(right)

        # Ignore reset timestamps; every provenance and payload decision is the same.
        left.execute("UPDATE tiles SET updated_at='reset' WHERE source='pending'")
        right.execute("UPDATE tiles SET updated_at='reset' WHERE source='pending'")
        self.assertEqual(_snapshot(left), _snapshot(right))

    def test_unknown_provenance_aborts_before_mutation(self):
        db = _db()
        self.addCleanup(db.close)
        _seed(db)
        db.execute(
            "INSERT INTO textures VALUES ('12-9-9','new_unclassified_source',X'01')"
        )
        db.commit()
        before = _snapshot(db)

        with self.assertRaisesRegex(RuntimeError, "unclassified textures.source"):
            apply_derived_purge(db)

        self.assertEqual(_snapshot(db), before)


if __name__ == "__main__":
    unittest.main()

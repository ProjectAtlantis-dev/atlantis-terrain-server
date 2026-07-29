import unittest
import os

os.environ.setdefault("DATAFORSYNINGEN_TOKEN", "test-token")

import coords
import colored_log
from classifier import official_water
import serve
import serve_flask
import terrain_seams
import texture


class ServeCruftTest(unittest.TestCase):
    def test_only_stereo_query_entry_point_remains(self):
        self.assertTrue(callable(serve.query_tiles_stereo))
        self.assertFalse(hasattr(serve, "query_tiles"))
        self.assertFalse(hasattr(serve, "to_stereo"))

    def test_zero_reader_terrain_helpers_stay_retired(self):
        retired = (
            (coords, "distance_stereo"),
            (coords, "distance_wgs84"),
            (coords, "tile_grid"),
            (official_water, "classifier_water_mask"),
            (serve, "_lod_leaf_descendants_cover"),
            (serve, "_lod_complete_ancestors"),
            (serve_flask, "_env_bool"),
            (serve_flask, "_arg_int"),
            (serve_flask, "_terrain_lod_history"),
            (terrain_seams, "resample_coarse_edge"),
            (texture, "_env_bool"),
            (colored_log, "BOLD"),
            (colored_log, "BRIGHT_WHITE"),
            (colored_log, "PINK"),
        )
        for module, name in retired:
            with self.subTest(module=module.__name__, name=name):
                self.assertFalse(hasattr(module, name))


if __name__ == "__main__":
    unittest.main()

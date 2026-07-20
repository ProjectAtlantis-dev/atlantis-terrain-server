import importlib
import os
import unittest
from unittest.mock import patch

import terrain_config


class TerrainConfigTests(unittest.TestCase):
    def tearDown(self):
        importlib.reload(terrain_config)

    def test_real_imagery_residency_extends_beyond_enhancement_depth(self):
        self.assertEqual(terrain_config.ENHANCE_DEPTH, 12)
        self.assertEqual(terrain_config.TERRAIN_MAX_DEPTH, 13)

    def test_comfy_enhancement_requires_explicit_environment_opt_in(self):
        with patch.dict(os.environ, {"COMFY_ENHANCE_ENABLED": "1"}):
            configured = importlib.reload(terrain_config)
            self.assertTrue(configured.ENHANCE_ENABLED)

        with patch.dict(os.environ, {}, clear=True):
            configured = importlib.reload(terrain_config)
            self.assertFalse(configured.ENHANCE_ENABLED)


if __name__ == "__main__":
    unittest.main()

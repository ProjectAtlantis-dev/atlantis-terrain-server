import io
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import serve_flask


class WaterTextureOverlayTest(unittest.TestCase):
    def test_pink_water_is_painted_into_the_requested_terrain_texture(self):
        source = np.full((16, 16, 3), (20, 80, 30), dtype=np.uint8)
        encoded = io.BytesIO()
        Image.fromarray(source, mode="RGB").save(encoded, format="JPEG", quality=100)
        water = np.zeros((2, 2), dtype=bool)
        water[:, 0] = True

        with (
            serve_flask.app.test_request_context(),
            patch.object(serve_flask, "_np", np),
            patch.object(serve_flask, "_Image", Image),
            patch.object(serve_flask, "_get_db", return_value=object()),
            patch("asset_catalog.paint_roads", return_value=(encoded.getvalue(), 0)),
            patch("coastline.read_water_mask", return_value=water),
        ):
            response = serve_flask._painted_texture_response(
                encoded.getvalue(), (0, 0, 1, 1), tile_id="12-1-2",
                headers={}, water_debug=True,
            )

        rendered = np.asarray(Image.open(io.BytesIO(response.get_data())).convert("RGB"))
        self.assertGreater(rendered[:, :4, 0].mean(), 235)
        self.assertGreater(rendered[:, :4, 2].mean(), 135)
        self.assertLess(rendered[:, -4:, 0].mean(), 60)

    def test_hydrography_is_blue_without_enabling_pink_sea(self):
        source = np.full((16, 16, 3), (20, 80, 30), dtype=np.uint8)
        encoded = io.BytesIO()
        Image.fromarray(source, mode="RGB").save(encoded, format="JPEG", quality=100)
        hydro = np.zeros((2, 2), dtype=bool)
        hydro[:, 0] = True

        with (
            serve_flask.app.test_request_context(),
            patch.object(serve_flask, "_np", np),
            patch.object(serve_flask, "_Image", Image),
            patch.object(serve_flask, "_get_db", return_value=object()),
            patch("asset_catalog.paint_roads", return_value=(encoded.getvalue(), 0)),
            patch("coastline.read_hydrography_mask", return_value=hydro),
            patch("coastline.read_water_mask", return_value=None),
        ):
            response = serve_flask._painted_texture_response(
                encoded.getvalue(), (0, 0, 1, 1), tile_id="12-1409-827",
                headers={}, hydro_debug=True,
            )

        rendered = np.asarray(Image.open(io.BytesIO(response.get_data())).convert("RGB"))
        self.assertLess(rendered[:, :4, 0].mean(), 30)
        self.assertGreater(rendered[:, :4, 2].mean(), 225)
        self.assertLess(rendered[:, -4:, 2].mean(), 80)


if __name__ == "__main__":
    unittest.main()

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

from terrain_upscale import upscale_heightmap, upscale_texture, upscale_tile_package


class TerrainUpscaleTest(unittest.TestCase):
    def setUp(self):
        rows, columns = np.mgrid[0:5, 0:5]
        self.heightmap = (100 + rows * 7 + columns * 3).astype(np.float32)
        self.bbox = (-100.0, 200.0, -60.0, 240.0)

    def test_is_deterministic_and_seed_changes_only_synthetic_samples(self):
        first = upscale_heightmap(self.heightmap, self.bbox, factor=4, seed=12)
        repeated = upscale_heightmap(self.heightmap, self.bbox, factor=4, seed=12)
        different = upscale_heightmap(self.heightmap, self.bbox, factor=4, seed=13)
        np.testing.assert_array_equal(first, repeated)
        np.testing.assert_array_equal(first[::4, ::4], self.heightmap)
        np.testing.assert_array_equal(different[::4, ::4], self.heightmap)
        self.assertFalse(np.array_equal(first[1:-1, 1:-1], different[1:-1, 1:-1]))

    def test_preserves_complete_bilinear_border(self):
        upscaled = upscale_heightmap(self.heightmap, self.bbox, factor=4)
        expected = np.linspace(self.heightmap[0, 0], self.heightmap[0, -1], 17)
        np.testing.assert_array_equal(upscaled[0], expected.astype(np.float32))
        np.testing.assert_array_equal(
            upscaled[-1],
            np.linspace(self.heightmap[-1, 0], self.heightmap[-1, -1], 17).astype(np.float32),
        )
        np.testing.assert_array_equal(
            upscaled[:, 0],
            np.linspace(self.heightmap[0, 0], self.heightmap[-1, 0], 17).astype(np.float32),
        )
        np.testing.assert_array_equal(
            upscaled[:, -1],
            np.linspace(self.heightmap[0, -1], self.heightmap[-1, -1], 17).astype(np.float32),
        )

    def test_suppresses_land_interpolation_and_noise_over_water(self):
        heightmap = self.heightmap.copy()
        heightmap[:, :2] = 0
        water = np.zeros_like(heightmap, dtype=bool)
        water[:, :2] = True
        upscaled = upscale_heightmap(
            heightmap, self.bbox, factor=4, water_mask=water,
        )
        # Nearest-neighbor expansion maps source columns 0 and 1 to the first
        # six output columns; column 6 is already closest to source column 2.
        self.assertTrue(np.all(upscaled[1:-1, :6] == 0))
        np.testing.assert_array_equal(upscaled[::4, ::4], heightmap)

    def test_package_contains_only_changed_heightmap_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "tile.zip"
            output_path = Path(directory) / "tile-upscaled.zip"
            heightmap_buffer = io.BytesIO()
            np.save(heightmap_buffer, self.heightmap, allow_pickle=False)
            mask_buffer = io.BytesIO()
            Image.fromarray(np.zeros((5, 5), dtype=np.uint8), mode="L").save(
                mask_buffer, format="PNG"
            )
            texture_buffer = io.BytesIO()
            Image.new("RGB", (8, 6), (40, 80, 120)).save(
                texture_buffer, format="JPEG"
            )
            manifest = {
                "format": "atlantis-terrain-tile-package-v1",
                "bbox": {"crs": "EPSG:3413", "values": self.bbox},
                "heightmap": {"file": "heightmap-final.npy", "shape": [5, 5]},
                "masks": {"effectiveWater": True},
            }
            with zipfile.ZipFile(source_path, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("heightmap-final.npy", heightmap_buffer.getvalue())
                archive.writestr("effective-water-mask.png", mask_buffer.getvalue())
                archive.writestr("texture-final.jpg", texture_buffer.getvalue())

            result = upscale_tile_package(source_path, output_path, factor=2)

            self.assertEqual(result.shape, (9, 9))
            with zipfile.ZipFile(output_path) as archive:
                self.assertEqual(
                    set(archive.namelist()),
                    {
                        "manifest.json", "heightmap-upscaled.npy",
                        "heightmap-upscaled.f32", "texture-upscaled.jpg",
                    },
                )
                packaged = np.load(
                    io.BytesIO(archive.read("heightmap-upscaled.npy")), allow_pickle=False,
                )
                self.assertEqual(packaged.shape, (9, 9))
                output_manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(
                    output_manifest["format"], "atlantis-terrain-tile-upscale-v1",
                )
                self.assertTrue(output_manifest["heightmap"]["bordersPreserved"])
                self.assertEqual(output_manifest["texture"]["shape"], [12, 16])

            # The output format is recursively consumable for another 4x pass.
            second_output = Path(directory) / "tile-upscaled-again.zip"
            second = upscale_tile_package(output_path, second_output, factor=2)
            self.assertEqual(second.shape, (17, 17))
            np.testing.assert_array_equal(second[::2, ::2], result)

    def test_texture_upscale_is_deterministic_and_has_expected_size(self):
        # A plain Lanczos enlarge — the noise painter is removed
        # (it damaged tiles with dark shadow artifacts), so there is no seed
        # and no terrain conditioning to vary.
        source = io.BytesIO()
        values = np.arange(4 * 5 * 3, dtype=np.uint8).reshape((4, 5, 3))
        Image.fromarray(values, mode="RGB").save(source, format="JPEG")
        first, first_size = upscale_texture(source.getvalue(), factor=4)
        second, second_size = upscale_texture(source.getvalue(), factor=4)
        self.assertEqual(first, second)
        self.assertEqual(first_size, (20, 16))
        self.assertEqual(second_size, first_size)


if __name__ == "__main__":
    unittest.main()

"""Trusted annotations and neural training-contract tests."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np

from classifier.neural import (
    INPUT_NAMES, augment_horizontal, build_network, load_model, train_model,
)
from classifier.training import (
    CLASSES, encode_segment_ids, geographic_group, geographic_split,
    init_classifier_annotations, read_annotations, read_classifier_suggestions,
    render_annotation_overlay, write_annotations,
)
from classifier.training_data import CHANNEL_NAMES, DATASET_VERSION, normalize_channels


class AnnotationStoreTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE tiles (tile_id TEXT PRIMARY KEY)")
        self.db.execute("INSERT INTO tiles VALUES ('12-10-20')")
        init_classifier_annotations(self.db)

    def tearDown(self):
        self.db.close()

    def test_assignments_round_trip_and_ignore_deletes(self):
        result = write_annotations(
            self.db, "12-10-20",
            [{"segmentId": 3, "className": "vegetation"}], region_count=5,
        )
        self.assertEqual(result, {3: "vegetation"})
        self.assertEqual(read_annotations(self.db, "12-10-20"), result)
        result = write_annotations(
            self.db, "12-10-20",
            [{"segmentId": 3, "className": None}], region_count=5,
        )
        self.assertEqual(result, {})

    def test_rejects_unknown_classes_and_regions(self):
        with self.assertRaisesRegex(ValueError, "unknown class"):
            write_annotations(
                self.db, "12-10-20", [{"segmentId": 0, "className": "purple"}],
                region_count=2,
            )
        with self.assertRaisesRegex(ValueError, "invalid segment"):
            write_annotations(
                self.db, "12-10-20", [{"segmentId": 8, "className": "vegetation"}],
                region_count=2,
            )


class GeographicSplitTest(unittest.TestCase):
    def test_neighboring_d12_tiles_share_a_geographic_group_and_split(self):
        first, second = "12-1471-826", "12-1470-827"
        self.assertEqual(geographic_group(first), geographic_group(second))
        self.assertEqual(geographic_split(first), geographic_split(second))

    def test_regression_tile_is_forced_out_of_training(self):
        tile = "12-1471-826"
        self.assertEqual(geographic_split(tile, {tile}), "regression")
        self.assertEqual(geographic_split("12-1470-827", {tile}), "regression")


class NeuralContractTest(unittest.TestCase):
    def test_existing_coarse_map_is_display_only_semantic_suggestion(self):
        from classifier.storage import init_classifier_tiles, write_classifier_tile
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE tiles (tile_id TEXT PRIMARY KEY)")
        db.execute("INSERT INTO tiles VALUES ('12-1-2')")
        init_classifier_tiles(db)
        write_classifier_tile(
            db, "12-1-2", np.asarray([[0, 1], [5, 8]], np.uint8),
            class_schema="coarse_v4", source="ladder_d12_v9",
            enforce_official_water=False,
        )
        suggestions, source = read_classifier_suggestions(db, "12-1-2", (2, 2))
        np.testing.assert_array_equal(suggestions, np.asarray([
            [CLASSES.index("bare_rock"), CLASSES.index("vegetation")],
            [CLASSES.index("unknown_shadow"), CLASSES.index("shore_rock")],
        ]))
        self.assertEqual(source, "ladder_d12_v9")
        db.close()

    def test_annotation_overlay_uses_thin_translucent_black_boundaries(self):
        rgb = np.full((1, 3, 3), 200, dtype=np.uint8)
        segmented = type("Segmented", (), {
            "labels": np.asarray([[0, 1, 1]], dtype=np.int32),
            "regions": [None, None],
        })()
        rendered = render_annotation_overlay(rgb, segmented, {})
        np.testing.assert_array_equal(rendered[0, 0], [200, 200, 200])
        np.testing.assert_array_equal(rendered[0, 1], [124, 124, 124])
        np.testing.assert_array_equal(rendered[0, 2], [200, 200, 200])

    def test_network_has_reference_and_semantic_heads(self):
        import torch
        network = build_network(base_channels=4)
        reference, semantic = network(torch.zeros(2, len(INPUT_NAMES), 32, 32))
        self.assertEqual(tuple(reference.shape), (2, 3, 32, 32))
        self.assertEqual(tuple(semantic.shape), (2, len(CLASSES), 32, 32))

    def test_horizontal_flip_negates_only_eastness(self):
        terrain = np.zeros((2, 3, len(CHANNEL_NAMES)), dtype=np.float32)
        terrain[..., CHANNEL_NAMES.index("southness")] = 0.7
        terrain[..., CHANNEL_NAMES.index("eastness")] = np.asarray([[1, 2, 3], [4, 5, 6]])
        sample = {
            "source": np.zeros((2, 3, 3), np.uint8),
            "reference": np.zeros((2, 3, 3), np.uint8),
            "terrain": terrain,
            "semantic": np.zeros((2, 3), np.int16),
            "bbox": np.zeros(4),
        }
        flipped = augment_horizontal(sample)
        np.testing.assert_allclose(
            flipped["terrain"][..., CHANNEL_NAMES.index("southness")], 0.7
        )
        np.testing.assert_array_equal(
            flipped["terrain"][..., CHANNEL_NAMES.index("eastness")],
            -np.asarray([[3, 2, 1], [6, 5, 4]]),
        )

    def test_normalization_preserves_southness_as_independent_input(self):
        channels = np.zeros((1, 1, len(CHANNEL_NAMES)), np.float32)
        channels[..., CHANNEL_NAMES.index("southness")] = 0.83
        normalized = normalize_channels(channels)
        self.assertAlmostEqual(
            float(normalized[..., CHANNEL_NAMES.index("southness")].item()), 0.83
        )

    def test_segment_id_png_encoding_is_lossless_past_255_regions(self):
        labels = np.asarray([[0, 255, 256, 70000]], dtype=np.int32)
        encoded = encode_segment_ids(labels).astype(np.uint32)
        decoded = encoded[..., 0] + encoded[..., 1] * 256 + encoded[..., 2] * 65536 - 1
        np.testing.assert_array_equal(decoded, labels)

    def test_tiny_two_stage_train_writes_loadable_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tile = next(
                f"12-{col}-100" for col in range(100, 200)
                if geographic_split(f"12-{col}-100") == "train"
            )
            tile_dir = root / tile
            tile_dir.mkdir()
            rng = np.random.default_rng(7)
            semantic = np.zeros((32, 32), np.int16)
            semantic[:, 16:] = CLASSES.index("vegetation")
            np.savez_compressed(
                tile_dir / "sample.npz",
                source=rng.integers(0, 256, (32, 32, 3), dtype=np.uint8),
                reference=rng.integers(0, 256, (32, 32, 3), dtype=np.uint8),
                terrain=np.zeros((32, 32, len(CHANNEL_NAMES)), np.float32),
                semantic=semantic, bbox=np.zeros(4),
            )
            class_pixels = {name: int(np.count_nonzero(semantic == index))
                            for index, name in enumerate(CLASSES)}
            manifest = {
                "format": DATASET_VERSION, "channelNames": list(CHANNEL_NAMES),
                "classNames": list(CLASSES),
                "entries": [{
                    "tile": tile, "file": f"{tile}/sample.npz", "split": "train",
                    "trustedPixels": int(semantic.size), "humanPixels": int(semantic.size),
                    "classPixels": class_pixels,
                }],
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            model_path = root / "model.pt"
            metadata = train_model(
                data_root=root, model_path=model_path, pretrain_steps=1,
                finetune_steps=1, batch_size=1, patch_size=32,
                base_channels=4, device="cpu",
            )
            loaded = load_model(model_path, device="cpu")
            self.assertEqual(metadata["format"], "terrain_unet_v2")
            self.assertEqual(loaded["format"], metadata["format"])
            self.assertTrue(model_path.with_suffix(".json").exists())


if __name__ == "__main__":
    unittest.main()

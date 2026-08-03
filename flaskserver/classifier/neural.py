"""Train and run the terrain-conditioned semantic U-Net.

The network learns in two stages. First it reconstructs aligned reference
imagery from the local texture and physical terrain channels. Then it learns
semantic classes only where trusted labels exist. Reference imagery is not an
inference input and is not stored in the model artifact.
"""
from __future__ import annotations

import datetime
import hashlib
import io
import json
import os
import random
import shutil
import sqlite3
from pathlib import Path

import numpy as np
from PIL import Image

from classifier.training import CLASSES
from classifier.training_data import (
    CHANNEL_NAMES,
    DEFAULT_ROOT,
    conditioning_channels,
    load_manifest,
    normalize_channels,
)
from database import GRID_N, _decompress_float32


MODEL_VERSION = "terrain_unet_v2"
MODEL_DIR = Path(__file__).parent / "models"
MODEL_PATH = MODEL_DIR / f"{MODEL_VERSION}.pt"
MODEL_CANDIDATE_PATH = MODEL_DIR / f"{MODEL_VERSION}.candidate.pt"
MODEL_METADATA_PATH = MODEL_DIR / f"{MODEL_VERSION}.json"
INPUT_NAMES = ("red", "green", "blue", *CHANNEL_NAMES)


def _torch():
    try:
        import torch
        return torch
    except ImportError as exc:  # pragma: no cover - depends on installation
        raise RuntimeError("PyTorch is required for classifier training") from exc


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def select_device(requested: str = "auto") -> str:
    torch = _torch()
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _group_norm(channels: int):
    torch = _torch()
    groups = min(8, channels)
    while channels % groups:
        groups -= 1
    return torch.nn.GroupNorm(groups, channels)


def _block(in_channels: int, out_channels: int):
    torch = _torch()
    return torch.nn.Sequential(
        torch.nn.Conv2d(in_channels, out_channels, 3, padding=1),
        _group_norm(out_channels),
        torch.nn.SiLU(inplace=True),
        torch.nn.Conv2d(out_channels, out_channels, 3, padding=1),
        _group_norm(out_channels),
        torch.nn.SiLU(inplace=True),
    )


def build_network(base_channels: int = 24):
    """Return a compact U-Net with reference-RGB and semantic heads."""
    torch = _torch()

    class TerrainUNet(torch.nn.Module):
        def __init__(self):
            super().__init__()
            base = base_channels
            self.enc1 = _block(len(INPUT_NAMES), base)
            self.enc2 = _block(base, base * 2)
            self.enc3 = _block(base * 2, base * 4)
            self.bottleneck = _block(base * 4, base * 8)
            self.pool = torch.nn.MaxPool2d(2)
            self.up3 = torch.nn.ConvTranspose2d(base * 8, base * 4, 2, 2)
            self.dec3 = _block(base * 8, base * 4)
            self.up2 = torch.nn.ConvTranspose2d(base * 4, base * 2, 2, 2)
            self.dec2 = _block(base * 4, base * 2)
            self.up1 = torch.nn.ConvTranspose2d(base * 2, base, 2, 2)
            self.dec1 = _block(base * 2, base)
            self.reference_head = torch.nn.Conv2d(base, 3, 1)
            self.semantic_head = torch.nn.Conv2d(base, len(CLASSES), 1)

        def forward(self, values):
            e1 = self.enc1(values)
            e2 = self.enc2(self.pool(e1))
            e3 = self.enc3(self.pool(e2))
            middle = self.bottleneck(self.pool(e3))
            d3 = self.dec3(torch.cat((self.up3(middle), e3), dim=1))
            d2 = self.dec2(torch.cat((self.up2(d3), e2), dim=1))
            d1 = self.dec1(torch.cat((self.up1(d2), e1), dim=1))
            return torch.sigmoid(self.reference_head(d1)), self.semantic_head(d1)

    return TerrainUNet()


def _manifest_digest(document: dict) -> str:
    stable = {
        "format": document.get("format"),
        "channelNames": document.get("channelNames"),
        "classNames": document.get("classNames"),
        "entries": document.get("entries", []),
    }
    encoded = json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


class PairDataset:
    def __init__(self, root: Path = DEFAULT_ROOT):
        self.root = Path(root)
        self.manifest = load_manifest(self.root)
        if tuple(self.manifest.get("channelNames", ())) != CHANNEL_NAMES:
            raise ValueError("dataset terrain-channel contract does not match trainer")
        if tuple(self.manifest.get("classNames", ())) != CLASSES:
            raise ValueError("dataset semantic-class contract does not match trainer")
        self.entries = list(self.manifest.get("entries", ()))

    def split(self, name: str, *, require_labels: bool = False) -> list[dict]:
        entries = [entry for entry in self.entries if entry.get("split") == name]
        if require_labels:
            entries = [entry for entry in entries if entry.get("trustedPixels", 0) > 0]
        return entries

    def load(self, entry: dict) -> dict[str, np.ndarray]:
        path = self.root / entry["file"]
        if not path.exists():
            raise ValueError(f"missing training pair: {path}")
        with np.load(path, allow_pickle=False) as sample:
            return {name: sample[name].copy() for name in (
                "source", "reference", "terrain", "semantic", "bbox",
            )}


def _input_array(sample: dict) -> np.ndarray:
    source = np.asarray(sample["source"], dtype=np.float32) / 255.0
    terrain = normalize_channels(sample["terrain"])
    return np.concatenate((source, terrain), axis=-1)


def augment_horizontal(sample: dict) -> dict:
    """Horizontal flip with the physical eastness sign corrected."""
    result = {name: np.flip(value, axis=1).copy() for name, value in sample.items()
              if name != "bbox"}
    result["terrain"][..., CHANNEL_NAMES.index("eastness")] *= -1.0
    result["bbox"] = sample["bbox"].copy()
    return result


def _random_patch(sample: dict, patch_size: int, rng: random.Random) -> dict:
    height, width = sample["source"].shape[:2]
    size = min(patch_size, height, width)
    y = rng.randrange(height - size + 1)
    x = rng.randrange(width - size + 1)
    output = {
        name: value[y:y + size, x:x + size].copy()
        for name, value in sample.items() if name != "bbox"
    }
    output["bbox"] = sample["bbox"].copy()
    return augment_horizontal(output) if rng.random() < 0.5 else output


def _batch(dataset: PairDataset, entries: list[dict], batch_size: int,
           patch_size: int, rng: random.Random, *, labeled: bool):
    torch = _torch()
    chosen = [rng.choice(entries) for _ in range(batch_size)]
    samples = [_random_patch(dataset.load(entry), patch_size, rng) for entry in chosen]
    if labeled:
        # Retry crops so sparse labels actually contribute to the fine-tune step.
        for index, sample in enumerate(samples):
            for _ in range(12):
                if np.any(sample["semantic"] >= 0):
                    break
                sample = _random_patch(dataset.load(chosen[index]), patch_size, rng)
            samples[index] = sample
    inputs = np.stack([_input_array(sample).transpose(2, 0, 1) for sample in samples])
    references = np.stack([
        np.asarray(sample["reference"], np.float32).transpose(2, 0, 1) / 255.0
        for sample in samples
    ])
    labels = np.stack([sample["semantic"] for sample in samples]).astype(np.int64)
    return torch.from_numpy(inputs), torch.from_numpy(references), torch.from_numpy(labels)


def _class_weights(dataset: PairDataset, entries: list[dict]):
    counts = np.zeros(len(CLASSES), dtype=np.float64)
    for entry in entries:
        for index, name in enumerate(CLASSES):
            counts[index] += entry.get("classPixels", {}).get(name, 0)
    present = counts > 0
    weights = np.zeros(len(CLASSES), dtype=np.float32)
    if np.any(present):
        inverse = counts[present].sum() / counts[present]
        weights[present] = np.sqrt(inverse / inverse.mean()).astype(np.float32)
    return weights


def evaluate(network, dataset: PairDataset, entries: list[dict], device: str) -> dict:
    torch = _torch()
    network.eval()
    confusion = np.zeros((len(CLASSES), len(CLASSES)), dtype=np.int64)
    l1_values: list[float] = []
    north_l1: list[float] = []
    south_l1: list[float] = []
    rows = [int(entry["tile"].split("-")[2]) for entry in entries]
    row_midpoint = float(np.median(rows)) if rows else 0.0
    with torch.no_grad():
        for entry in entries:
            sample = dataset.load(entry)
            values = torch.from_numpy(_input_array(sample).transpose(2, 0, 1)[None]).to(device)
            predicted_rgb, logits = network(values)
            reference = torch.from_numpy(
                np.asarray(sample["reference"], np.float32).transpose(2, 0, 1)[None] / 255.0
            ).to(device)
            l1 = float(torch.nn.functional.l1_loss(predicted_rgb, reference).item())
            l1_values.append(l1)
            (north_l1 if int(entry["tile"].split("-")[2]) >= row_midpoint else south_l1).append(l1)
            truth = np.asarray(sample["semantic"], dtype=np.int64)
            prediction = logits.argmax(1).cpu().numpy()[0]
            valid = truth >= 0
            if np.any(valid):
                pairs = truth[valid] * len(CLASSES) + prediction[valid]
                confusion += np.bincount(pairs, minlength=len(CLASSES) ** 2).reshape(confusion.shape)
    total = int(confusion.sum())
    correct = int(np.trace(confusion))
    per_class = {}
    for index, name in enumerate(CLASSES):
        true_positive = int(confusion[index, index])
        truth_count = int(confusion[index].sum())
        predicted_count = int(confusion[:, index].sum())
        union = truth_count + predicted_count - true_positive
        per_class[name] = {
            "pixels": truth_count,
            "precision": true_positive / predicted_count if predicted_count else None,
            "recall": true_positive / truth_count if truth_count else None,
            "iou": true_positive / union if union else None,
        }
    return {
        "tiles": len(entries), "labeledPixels": total,
        "accuracy": correct / total if total else None,
        "referenceL1": float(np.mean(l1_values)) if l1_values else None,
        "northReferenceL1": float(np.mean(north_l1)) if north_l1 else None,
        "southReferenceL1": float(np.mean(south_l1)) if south_l1 else None,
        "perClass": per_class,
        "confusion": confusion.tolist(),
    }


def train_model(*, data_root: Path = DEFAULT_ROOT, model_path: Path = MODEL_PATH,
                pretrain_steps: int = 2000, finetune_steps: int = 2000,
                batch_size: int = 4, patch_size: int = 128,
                learning_rate: float = 2e-4, seed: int = 20260803,
                device: str = "auto", base_channels: int = 24) -> dict:
    torch = _torch()
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    rng = random.Random(seed)
    dataset = PairDataset(data_root)
    train_entries = dataset.split("train")
    labeled_entries = dataset.split("train", require_labels=True)
    if not train_entries:
        raise ValueError("no exported training-split pairs; run classifier_train.py export")
    if finetune_steps and not labeled_entries:
        raise ValueError("no trusted labels on exported training-split pairs")
    if finetune_steps and not any(
        int(entry.get("humanPixels", 0)) > 0 for entry in labeled_entries
    ):
        raise ValueError(
            "semantic fine-tuning needs human labels; official water alone is insufficient"
        )
    represented_classes = {
        name for entry in labeled_entries for name, count
        in entry.get("classPixels", {}).items() if int(count) > 0
    }
    if finetune_steps and len(represented_classes) < 2:
        raise ValueError("semantic fine-tuning needs at least two represented classes")
    selected_device = select_device(device)
    network = build_network(base_channels).to(selected_device)
    optimizer = torch.optim.AdamW(network.parameters(), lr=learning_rate, weight_decay=1e-4)
    history = {"pretrainLoss": [], "finetuneLoss": []}
    network.train()
    for _ in range(pretrain_steps):
        values, references, _ = _batch(
            dataset, train_entries, batch_size, patch_size, rng, labeled=False
        )
        values, references = values.to(selected_device), references.to(selected_device)
        predicted_rgb, _ = network(values)
        loss = torch.nn.functional.l1_loss(predicted_rgb, references)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        history["pretrainLoss"].append(float(loss.item()))
    weights = torch.from_numpy(_class_weights(dataset, labeled_entries)).to(selected_device)
    for _ in range(finetune_steps):
        values, references, labels = _batch(
            dataset, labeled_entries, batch_size, patch_size, rng, labeled=True
        )
        values, references, labels = (
            values.to(selected_device), references.to(selected_device), labels.to(selected_device)
        )
        predicted_rgb, logits = network(values)
        semantic_loss = torch.nn.functional.cross_entropy(
            logits, labels, weight=weights, ignore_index=-1
        )
        reconstruction_loss = torch.nn.functional.l1_loss(predicted_rgb, references)
        loss = semantic_loss + reconstruction_loss * 0.1
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        history["finetuneLoss"].append(float(loss.item()))
    metrics = {
        name: evaluate(network, dataset, dataset.split(name), selected_device)
        for name in ("train", "validation", "test", "regression")
    }
    created_at = _utc_now()
    metadata = {
        "format": MODEL_VERSION, "createdAt": created_at,
        "inputNames": list(INPUT_NAMES), "classNames": list(CLASSES),
        "baseChannels": base_channels, "datasetDigest": _manifest_digest(dataset.manifest),
        "datasetEntries": len(dataset.entries), "seed": seed, "device": selected_device,
        "steps": {"pretrain": pretrain_steps, "finetune": finetune_steps},
        "metrics": metrics,
        "finalLoss": {
            name: values[-1] if values else None for name, values in history.items()
        },
    }
    model_path = Path(model_path)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = model_path.with_suffix(model_path.suffix + ".tmp")
    torch.save({**metadata, "stateDict": network.state_dict()}, temporary_path)
    os.replace(temporary_path, model_path)
    metadata_path = model_path.with_suffix(".json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def load_model(model_path: Path = MODEL_PATH, *, device: str = "auto") -> dict:
    torch = _torch()
    path = Path(model_path)
    if not path.exists():
        raise ValueError(f"model artifact does not exist: {path}")
    selected_device = select_device(device)
    artifact = torch.load(path, map_location=selected_device, weights_only=False)
    if artifact.get("format") != MODEL_VERSION:
        raise ValueError("unsupported classifier model artifact")
    if tuple(artifact.get("inputNames", ())) != INPUT_NAMES:
        raise ValueError("model input contract does not match runtime")
    if tuple(artifact.get("classNames", ())) != CLASSES:
        raise ValueError("model class contract does not match runtime")
    network = build_network(int(artifact.get("baseChannels", 24))).to(selected_device)
    network.load_state_dict(artifact["stateDict"])
    network.eval()
    return {**artifact, "network": network, "device": selected_device}


def model_metadata(model_path: Path = MODEL_PATH) -> dict | None:
    path = Path(model_path).with_suffix(".json")
    if path.exists():
        return json.loads(path.read_text())
    if not Path(model_path).exists():
        return None
    artifact = load_model(model_path, device="cpu")
    return {key: value for key, value in artifact.items()
            if key not in {"stateDict", "network"}}


def promote_model(candidate_path: Path = MODEL_CANDIDATE_PATH,
                  active_path: Path = MODEL_PATH, *, allow_unscored: bool = False) -> dict:
    """Validate and atomically promote a candidate checkpoint to runtime."""
    candidate_path, active_path = Path(candidate_path), Path(active_path)
    artifact = load_model(candidate_path, device="cpu")
    metadata = {key: value for key, value in artifact.items()
                if key not in {"stateDict", "network"}}
    if not allow_unscored:
        metrics = metadata.get("metrics", {})
        missing = [
            split for split in ("validation", "regression")
            if int(metrics.get(split, {}).get("labeledPixels", 0)) <= 0
        ]
        if missing:
            raise ValueError(
                "candidate has no trusted semantic score for: " + ", ".join(missing)
            )
    active_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_model = active_path.with_suffix(active_path.suffix + ".tmp")
    temporary_json = active_path.with_suffix(".json.tmp")
    shutil.copyfile(candidate_path, temporary_model)
    temporary_json.write_text(json.dumps(metadata, indent=2) + "\n")
    os.replace(temporary_model, active_path)
    os.replace(temporary_json, active_path.with_suffix(".json"))
    return metadata


def _runtime_sample(db: sqlite3.Connection, tile_id: str) -> dict:
    row = db.execute(
        "SELECT t.depth,t.x_min,t.y_min,t.x_max,t.y_max,t.heightmap,x.texture "
        "FROM tiles t JOIN textures x USING(tile_id) WHERE t.tile_id=?", (tile_id,)
    ).fetchone()
    if row is None or int(row[0]) != 12 or row[5] is None or row[6] is None:
        raise ValueError(f"{tile_id} is not a ready D12 inference tile")
    source = np.asarray(Image.open(io.BytesIO(row[6])).convert("RGB"), dtype=np.uint8)
    heightmap = _decompress_float32(row[5], (GRID_N, GRID_N))
    terrain = conditioning_channels(heightmap, float(row[3]) - float(row[1]), source.shape[0])
    return {"source": source, "terrain": terrain}


def predict_tile(db: sqlite3.Connection, tile_id: str, *, model_path: Path = MODEL_PATH,
                 loaded_model: dict | None = None) -> dict:
    torch = _torch()
    artifact = loaded_model or load_model(model_path)
    sample = _runtime_sample(db, tile_id)
    values = torch.from_numpy(_input_array(sample).transpose(2, 0, 1)[None]).to(
        artifact["device"]
    )
    with torch.no_grad():
        _, logits = artifact["network"](values)
        probabilities = torch.softmax(logits, dim=1)
        confidence, labels = probabilities.max(dim=1)
    labels_array = labels.cpu().numpy()[0].astype(np.uint8)
    confidence_array = np.rint(confidence.cpu().numpy()[0] * 255).astype(np.uint8)
    from classifier.storage import COARSE_V4_SCHEMA, write_classifier_tile
    write_classifier_tile(
        db, tile_id, labels_array, class_schema=COARSE_V4_SCHEMA,
        confidence=confidence_array, source=f"model:{MODEL_VERSION}",
    )
    return {
        "tile": tile_id, "model": MODEL_VERSION,
        "pixels": int(labels_array.size), "regions": int(labels_array.size),
        "meanConfidence": float(confidence_array.mean() / 255.0),
    }

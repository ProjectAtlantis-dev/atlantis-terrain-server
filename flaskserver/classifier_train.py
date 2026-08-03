#!/usr/bin/env python3
"""Export pairs, train/evaluate the U-Net, and run D12 inference."""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import regression_cases
from classifier.neural import (
    MODEL_CANDIDATE_PATH, MODEL_PATH, PairDataset, evaluate, load_model,
    promote_model, train_model,
)
from classifier.training_data import (
    DEFAULT_ROOT, export_tile_pair, load_manifest, ready_d12_tiles, write_manifest,
)


def _regression_tiles() -> set[str]:
    return {str(case.get("tile", "")) for case in regression_cases.load_cases()}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db", type=Path, default=Path(__file__).with_name("terrain.db")
    )
    commands = parser.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export", help="materialize aligned training pairs")
    export.add_argument("tiles", nargs="*")
    export.add_argument("--all-ready", action="store_true")
    export.add_argument("--include-regressions", action="store_true")
    export.add_argument("--allow-network", action="store_true")
    export.add_argument("--strict", action="store_true", help="stop at the first missing reference")
    export.add_argument("--size", type=int, default=256)
    export.add_argument("--out", type=Path, default=DEFAULT_ROOT)

    train = commands.add_parser("train", help="pretrain then semantic-finetune")
    train.add_argument("--data-root", type=Path, default=DEFAULT_ROOT)
    train.add_argument("--model", type=Path, default=MODEL_CANDIDATE_PATH)
    train.add_argument("--pretrain-steps", type=int, default=2000)
    train.add_argument("--finetune-steps", type=int, default=2000)
    train.add_argument("--batch-size", type=int, default=4)
    train.add_argument("--patch-size", type=int, default=128)
    train.add_argument("--learning-rate", type=float, default=2e-4)
    train.add_argument("--seed", type=int, default=20260803)
    train.add_argument("--device", default="auto")

    score = commands.add_parser("evaluate", help="score a saved checkpoint")
    score.add_argument("--data-root", type=Path, default=DEFAULT_ROOT)
    score.add_argument("--model", type=Path, default=MODEL_CANDIDATE_PATH)
    score.add_argument("--device", default="auto")

    predict = commands.add_parser("predict", help="write model class maps")
    predict.add_argument("tiles", nargs="+")
    predict.add_argument("--model", type=Path, default=MODEL_PATH)
    predict.add_argument("--device", default="auto")
    promote = commands.add_parser("promote", help="atomically activate a scored candidate")
    promote.add_argument("--candidate", type=Path, default=MODEL_CANDIDATE_PATH)
    promote.add_argument("--active", type=Path, default=MODEL_PATH)
    promote.add_argument("--allow-unscored", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    regressions = _regression_tiles()
    if args.command == "export":
        if not args.tiles and not args.all_ready and not args.include_regressions:
            raise SystemExit("export needs tile IDs, --all-ready, or --include-regressions")
        with sqlite3.connect(args.db) as db:
            requested = set(args.tiles)
            if args.all_ready:
                requested.update(ready_d12_tiles(db))
            if args.include_regressions:
                requested.update(regressions)
            existing = {entry["tile"]: entry for entry in load_manifest(args.out)["entries"]}
            failures = {}
            for tile_id in sorted(requested):
                try:
                    existing[tile_id] = export_tile_pair(
                        db, tile_id, args.out, size=args.size,
                        allow_network=args.allow_network, regression_tiles=regressions,
                    )
                except (FileNotFoundError, ValueError) as exc:
                    if args.strict:
                        raise
                    failures[tile_id] = str(exc)
            manifest = write_manifest(args.out, list(existing.values()))
        print(json.dumps({
            "root": str(args.out), "exported": len(manifest["entries"]),
            "requested": len(requested), "skipped": failures,
        }, indent=2))
        return 0
    if args.command == "train":
        result = train_model(
            data_root=args.data_root, model_path=args.model,
            pretrain_steps=args.pretrain_steps, finetune_steps=args.finetune_steps,
            batch_size=args.batch_size, patch_size=args.patch_size,
            learning_rate=args.learning_rate, seed=args.seed, device=args.device,
        )
        print(json.dumps(result, indent=2))
        return 0
    if args.command == "evaluate":
        dataset = PairDataset(args.data_root)
        artifact = load_model(args.model, device=args.device)
        result = {
            split: evaluate(artifact["network"], dataset, dataset.split(split), artifact["device"])
            for split in ("train", "validation", "test", "regression")
        }
        print(json.dumps(result, indent=2))
        return 0
    if args.command == "promote":
        result = promote_model(
            args.candidate, args.active, allow_unscored=args.allow_unscored
        )
        print(json.dumps({
            "active": str(args.active), "format": result["format"],
            "createdAt": result["createdAt"], "metrics": result["metrics"],
        }, indent=2))
        return 0
    from classifier.neural import predict_tile
    artifact = load_model(args.model, device=args.device)
    with sqlite3.connect(args.db) as db:
        for tile_id in args.tiles:
            print(json.dumps(predict_tile(
                db, tile_id, model_path=args.model, loaded_model=artifact
            )))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

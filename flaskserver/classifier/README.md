# Terrain classifier training

The classifier is a terrain-conditioned U-Net. It predicts the nine
`coarse_v4` surface classes from inputs that exist at runtime:

- SPOT RGB texture
- elevation and local relief
- slope
- southness and eastness
- modeled sun exposure

Southness is an independent signed channel. The network can therefore learn
that otherwise similar ground has a different color distribution on a
south-facing slope; there is no south-slope color rule in inference.

## Workflow

1. Fly the normal 3D terrain view with gridlines enabled. Right-click a bad
   D12 tile and choose **Flag classifier regression**. This is the start of
   the workflow, not a detour to a tile gallery.
2. The report is added to `regression_cases.json`. Its aligned pair is cached
   as a frozen `regression` example when its reference is available. A
   regression report is failure evidence, never an inferred training label.
3. For semantic correction, open the reported tile in
   `training.html?tile=12-COL-ROW` and paint only classes you can identify.
   Labels on regression tiles are used only for scoring. Label comparable
   nearby, non-regression tiles to add training supervision.
4. Export aligned pairs. Pretraining uses every training-split pair to learn
   reconstruction of the reference appearance. Semantic fine-tuning uses only
   pixels with trusted human labels or official water authority.
5. Train, inspect validation/test and per-class metrics, then explicitly run
   inference. Merely filing or labeling a case never silently changes the
   deployed classifier.

The static gallery and `pipeline.html` remain diagnostic views. They are not
the primary collection workflow.

## Reproducible commands

From `flaskserver/`:

```bash
# Cache-only export of all ready D12 tiles plus frozen regression cases.
venv/bin/python classifier_train.py export --all-ready --include-regressions

# Fetch missing Google references only when deliberately requested.
venv/bin/python classifier_train.py export --all-ready --include-regressions --allow-network

# Stage 1: reference reconstruction. Stage 2: trusted semantic fine-tuning.
venv/bin/python classifier_train.py train \
  --pretrain-steps 2000 --finetune-steps 2000 --seed 20260803

# Re-score the immutable geographic splits and regression set.
venv/bin/python classifier_train.py evaluate

# Activate only after reviewing validation and regression metrics.
venv/bin/python classifier_train.py promote

# Persist coarse_v4 class and confidence maps for selected D12 tiles.
venv/bin/python classifier_train.py predict 12-1373-784
```

Pairs live under the ignored local directory `sample/training_v2/`. Each
`sample.npz` contains aligned source RGB, reference RGB, raw physical channels,
trusted semantic mask (`-1` means unlabeled), and bbox. `manifest.json` records
the file hash, D8 geographic group, split, source provenance, and class counts.

Training writes `classifier/models/terrain_unet_v2.candidate.pt`. Promotion
validates the artifact and requires trusted validation and regression scores,
then atomically copies it to the active `terrain_unet_v2.pt`. Use
`promote --allow-unscored` only as an explicit bootstrap escape hatch. JSON
sidecars contain the input/class contracts, stable dataset digest, seed,
training stages, and metrics. Checkpoints do not contain reference images.
Runtime inference cannot read Google imagery.

## Leakage and evaluation rules

- All D12 tiles under one D8 ancestor share a split.
- A regression case's entire D8 geographic group is excluded from training,
  even if neighboring tiles in that group are annotated.
- Horizontal augmentation negates eastness; southness keeps its sign.
- Validation, test, and regression reports include reconstruction L1,
  semantic confusion, accuracy, and per-class precision/recall/IoU.
- Official water overrides model output when a classifier tile is stored.
- Official-water authority contributes labels, but cannot by itself satisfy
  the semantic-training gate: at least one human-labeled region and two
  represented classes are required.

`segmentation.py` still provides deterministic 40 m superpixels for the
annotation brush. Superpixels are a labeling convenience, not classifier
inference units.

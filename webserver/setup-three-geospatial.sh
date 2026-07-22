#!/usr/bin/env bash
# Reproducible setup for the local three-geospatial fork.
#
# The frontend vite-aliases @takram/* to webserver/three-geospatial/packages/*/src.
# That directory is a git clone of upstream pinned at BASE_COMMIT with this
# project's WebGPU cloud/atmosphere port applied on top as tracked vendored
# patches. The smaller runtime-fixes patch captures dispatch throttling and
# explicit compute ownership added after the original port checkpoint.
#
# Regenerate the patch after committing new work in the fork:
#   cd three-geospatial && git diff <BASE_COMMIT> HEAD > ../three-geospatial-port.patch
# ...and update PATCHED_STATE_COMMIT below.

set -euo pipefail

BASE_COMMIT=b012ad06
PATCHED_STATE_COMMIT=86d74048   # provenance only; exists on this machine's webgpu-clouds-port branch
UPSTREAM=https://github.com/takram-design-engineering/three-geospatial.git

cd "$(dirname "$0")"

if [ ! -d three-geospatial/.git ]; then
  git clone "$UPSTREAM" three-geospatial
fi

cd three-geospatial

if ! git cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null; then
  git fetch origin
fi

git checkout -B webgpu-clouds-port "$BASE_COMMIT"
git apply --index ../three-geospatial-port.patch
git apply --index ../three-geospatial-runtime-fixes.patch
git commit -m "Apply vendored WebGPU cloud/atmosphere port (three-geospatial-port.patch, from $PATCHED_STATE_COMMIT)"

echo "three-geospatial ready: $BASE_COMMIT + three-geospatial-port.patch"

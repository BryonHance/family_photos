#!/usr/bin/env bash
# Downloads the pet trial run's ONNX models into models/pets/ (or the directory
# given as $1) and checks their pinned SHA-256s: D-FINE-S trained on COCO (finds
# cats and dogs) and DINOv2-S (the light embedding). Both are Apache-2.0, in
# onnx-community's conversions at pinned revisions. The Avito CLIP-L embedding has
# no ONNX release; `pixi run models` exports it (scripts/export-avito.py).
# See docs/research/face-and-pet-recognition.md. Needs curl and sha256sum.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$here/../../models/pets}"
mkdir -p "$dest"

fetch() {
  local name="$1" url="$2" sha256="$3"
  if echo "$sha256  $dest/$name" | sha256sum --check --quiet --status 2>/dev/null; then
    echo "$name is present and verified."
    return
  fi
  echo "Downloading $url"
  curl --fail --location --silent --show-error --output "$dest/$name.part" "$url"
  if ! echo "$sha256  $dest/$name.part" | sha256sum --check --quiet --status; then
    rm -f "$dest/$name.part"
    echo "$name does not match its pinned SHA-256; refusing to use it." >&2
    exit 1
  fi
  mv -f "$dest/$name.part" "$dest/$name"
}

fetch dfine_s_coco.onnx \
  https://huggingface.co/onnx-community/dfine_s_coco-ONNX/resolve/a3cf03147a9b86c78475139115c8ac142577352d/onnx/model.onnx \
  cd8a49a945feda6d28c6304ae8ae85c2759ba1d78a5a83a22c5ce8db82ef7238
fetch dinov2_small.onnx \
  https://huggingface.co/onnx-community/dinov2-small-ONNX/resolve/08c606e3123472a388efa59181b677d428f69bbd/onnx/model.onnx \
  6266c3cd72db6953cecdcbfeab9422a9f783d96f1a4e296ba70ffbac43b54a18
echo "Pet models in $dest are present and verified."

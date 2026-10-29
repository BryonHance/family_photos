#!/usr/bin/env bash
# Downloads the pet models into models/pets/ (or the directory given as $1) and
# checks their pinned SHA-256s: D-FINE-S trained on COCO, which finds the cats
# and dogs, from onnx-community's conversion at a pinned revision. It is
# Apache-2.0, but too big to commit. Used by `pixi run models` and the
# Dockerfile. Needs curl and sha256sum.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$here/../models/pets}"
# One checksum list, shared with the server's startup check.
checksums="${PET_MODEL_CHECKSUMS:-$here/../src/server/pets/models.sha256}"
mkdir -p "$dest"

fetch() {
  local name="$1" url="$2" sha256
  sha256="$(awk -v name="$name" '$2 == name {print $1}' "$checksums")"
  if [ -z "$sha256" ]; then
    echo "$name has no pinned SHA-256 in $checksums." >&2
    exit 1
  fi
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
  https://huggingface.co/onnx-community/dfine_s_coco-ONNX/resolve/a3cf03147a9b86c78475139115c8ac142577352d/onnx/model.onnx
echo "Pet models in $dest are present and verified."

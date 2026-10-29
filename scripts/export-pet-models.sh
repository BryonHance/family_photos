#!/usr/bin/env bash
# Exports the Avito CLIP-L vision tower into models/pets/ (or the directory given
# as $1) for development, through scripts/export-avito.py in pixi's pet-export
# environment, unless it is already there, matches its recorded SHA-256 and was
# made by the current export-avito.py (which pins the revision). Used by
# `pixi run models`; the Dockerfile runs export-avito.py itself. Needs pixi and sha256sum.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$here/../models/pets}"
model="$dest/avito_clip_l.onnx"
# Which export-avito.py made the model, so that changing the revision exports it again.
source="$(sha256sum "$here/export-avito.py" | cut -d' ' -f1)"

if [ -f "$model.sha256" ] && [ "$(cat "$model.source" 2>/dev/null)" = "$source" ] \
  && (cd "$dest" && sha256sum --check --quiet --status avito_clip_l.onnx.sha256 2>/dev/null); then
  echo "avito_clip_l.onnx is present and verified."
  exit 0
fi

rm -f "$model.source"
pixi run --manifest-path "$here/../pixi.toml" --locked --environment pet-export python "$here/export-avito.py" "$dest"
echo "$source" > "$model.source"

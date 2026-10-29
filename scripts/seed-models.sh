#!/usr/bin/env bash
# In a linked worktree (such as an agent's under .claude/worktrees/), fills
# models/ from the main checkout's before `pixi run models` fetches and exports
# what is still missing. The model files are hard-linked, so a worktree costs
# no extra 1.3 GB and needs no PyTorch export; the Avito model's recorded
# SHA-256 and .source are copied, because the export rewrites them in place.
# The fetch and export scripts then check every file as usual, and replace one
# that is wrong by renaming a new file over it, never by writing into it.
# Does nothing in the main checkout. Used by `pixi run models`. Needs git.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
main="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
[ "$root" = "$main" ] && exit 0
[ -d "$main/models" ] || exit 0

seed() {
  local how="$1" name="$2"
  [ -f "$main/models/$name" ] && [ ! -e "$root/models/$name" ] || return 0
  mkdir -p "$(dirname "$root/models/$name")"
  if [ "$how" = link ]; then
    # A copy when the main checkout is on another filesystem.
    ln "$main/models/$name" "$root/models/$name" 2>/dev/null || cp "$main/models/$name" "$root/models/$name"
  else
    cp "$main/models/$name" "$root/models/$name"
  fi
  echo "Seeded models/$name from $main."
}

# The same lists the fetch scripts and the server check.
for name in $(awk '{print $2}' "$here/../src/server/faces/models.sha256"); do seed link "$name"; done
for name in $(awk '{print $2}' "$here/../src/server/pets/models.sha256"); do seed link "pets/$name"; done
seed link pets/avito_clip_l.onnx
seed copy pets/avito_clip_l.onnx.sha256
seed copy pets/avito_clip_l.onnx.source

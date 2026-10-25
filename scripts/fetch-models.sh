#!/usr/bin/env bash
# Downloads InsightFace's buffalo_sc face models into models/ (or the directory
# given as $1) and checks their pinned SHA-256s. The weights are for
# non-commercial research only, so they are never committed; see the README.
# Used by `pixi run models` and the Dockerfile. Needs curl, unzip and sha256sum.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-$here/../models}"
# One checksum list, shared with the server's startup check.
checksums="${MODEL_CHECKSUMS:-$here/../src/server/faces/models.sha256}"
url="https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip"
zip_sha256="${MODEL_ZIP_SHA256:-57d31b56b6ffa911c8a73cfc1707c73cab76efe7f13b675a05223bf42de47c72}"

mkdir -p "$dest"
checksums="$(cd "$(dirname "$checksums")" && pwd)/$(basename "$checksums")"
if (cd "$dest" && sha256sum --check --quiet --status "$checksums") 2>/dev/null; then
  echo "Face models in $dest are present and verified."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl --fail --location --silent --show-error --output "$tmp/buffalo_sc.zip" "$url"
if ! echo "$zip_sha256  $tmp/buffalo_sc.zip" | sha256sum --check --quiet --status; then
  echo "buffalo_sc.zip does not match its pinned SHA-256; refusing to use it." >&2
  exit 1
fi
unzip -q -o "$tmp/buffalo_sc.zip" -d "$tmp/models"
if ! (cd "$tmp/models" && sha256sum --check --quiet "$checksums"); then
  echo "A model file does not match its pinned SHA-256; refusing to use it." >&2
  exit 1
fi
awk '{print $2}' "$checksums" | while read -r name; do mv -f "$tmp/models/$name" "$dest/$name"; done
echo "Face models downloaded to $dest and verified."

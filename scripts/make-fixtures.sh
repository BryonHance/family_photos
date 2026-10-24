#!/usr/bin/env bash
# Regenerates the test fixtures. Every fixture is generated here, never a real
# family Photo, because the repo is public (ADR-0001). Needs ImageMagick and
# heif-enc (libheif).
set -euo pipefail
cd "$(dirname "$0")/.."
exiftool="$(ls node_modules/.pnpm/exiftool-vendored.pl@*/node_modules/exiftool-vendored.pl/bin/exiftool | head -1)"
out=fixtures

# A small gradient with full EXIF and GPS, as a camera would write it.
magick -size 64x48 gradient:steelblue-orange -strip "$out/full-exif.jpg"
"$exiftool" -q -overwrite_original \
  -Make="Canon" -Model="Canon EOS R6" -LensModel="RF24-105mm F4 L IS USM" \
  -ExposureTime=0.004 -FNumber=4 -ISO=200 -FocalLength=50 \
  -DateTimeOriginal="2024:07:04 18:30:00" -OffsetTimeOriginal="-07:00" \
  -GPSLatitude=37.7749 -GPSLatitudeRef=N -GPSLongitude=122.4194 -GPSLongitudeRef=W \
  "$out/full-exif.jpg"

# Same image recorded sideways: Orientation 6 means "rotate 90 CW to view".
magick -size 64x48 gradient:steelblue-orange -strip "$out/rotated.jpg"
"$exiftool" -q -overwrite_original -Orientation#=6 -Make="Apple" -Model="iPhone 15" "$out/rotated.jpg"

# iPhone-style HEIC: landscape pixels (red top half, blue bottom half) that an
# iPhone held upright would record, with both an HEIF irot box and EXIF
# Orientation 6. heif-enc turns the source JPEG's Orientation into the irot box
# and keeps the EXIF, as an iPhone does. Viewed upright it is portrait, red on
# the right.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
magick -size 64x24 xc:red -size 64x24 xc:blue -append -strip "$tmp/iphone.jpg"
"$exiftool" -q -overwrite_original -Orientation#=6 -Make="Apple" -Model="iPhone 15 Pro" \
  -DateTimeOriginal="2024:07:04 18:30:00" -OffsetTimeOriginal="-07:00" "$tmp/iphone.jpg"
heif-enc -q 90 -o "$out/iphone.heic" "$tmp/iphone.jpg"

# Formats the browser previews itself, and formats with no preview in v1.
magick -size 64x48 gradient:steelblue-orange -strip "$out/gradient.png"
magick -size 64x48 gradient:steelblue-orange -strip "$out/gradient.webp"
magick -size 64x48 gradient:steelblue-orange -strip -compress zip "$out/scan.tif"
"$exiftool" -q -overwrite_original -Make="Epson" -Model="Perfection V600" "$out/scan.tif"

# A minimal RAW: a TIFF that ExifTool recognizes as DNG from its DNGVersion.
cp "$out/scan.tif" "$out/raw.dng"
"$exiftool" -q -overwrite_original -DNGVersion="1.4.0.0" -Make="Canon" -Model="Canon EOS R6" "$out/raw.dng"

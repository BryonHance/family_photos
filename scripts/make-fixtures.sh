#!/usr/bin/env bash
# Regenerates the test fixtures. Every fixture is generated here, never a real
# family Photo, because the repo is public (ADR-0001). Needs ImageMagick.
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

# Stripped of all metadata, as a messaging app would send it.
magick -size 64x48 gradient:steelblue-orange -strip "$out/no-metadata.jpg"

# Has EXIF (camera Fields) but no Date taken.
magick -size 64x48 gradient:steelblue-orange -strip "$out/no-date-taken.jpg"
"$exiftool" -q -overwrite_original -Make="Canon" -Model="Canon EOS R6" "$out/no-date-taken.jpg"

# The full-EXIF JPEG cut off partway through its image data, as an interrupted
# copy leaves it. Its EXIF still reads.
head -c 700 "$out/full-exif.jpg" > "$out/truncated.jpg"

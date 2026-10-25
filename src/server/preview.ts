import decodeHeic from "heic-decode";
import jpeg from "jpeg-js";
import type { Preview } from "../shared/analysis.ts";

/** Formats every browser can show from its own copy of the file. */
const BROWSER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

export const isHeic = (mimeType: string) => HEIC_TYPES.has(mimeType);

/** How a Photo records which way up it goes, as ExifTool reads it. */
export type Orientation = {
  /** The EXIF Orientation, 1 to 8, when the Photo has one. */
  exif?: number;
  /** Whether a HEIC has an HEIF rotation or mirroring box (irot/imir). */
  heifTransform: boolean;
};

/** Upright RGBA pixels. */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };

/**
 * Decodes a HEIC to upright RGBA pixels. libheif applies the HEIF rotation and
 * mirroring (irot/imir), which is how an iPhone records orientation. An iPhone
 * also writes an EXIF Orientation that describes that same turn, so it is
 * applied only when the HEIC has no irot or imir box; applying both would
 * rotate the Photo twice.
 */
export async function decodeUprightHeic(bytes: Uint8Array, orientation: Orientation): Promise<Pixels> {
  const decoded = await decodeHeic({ buffer: bytes });
  return orientation.heifTransform ? decoded : applyExifOrientation(decoded, orientation.exif ?? 1);
}

/**
 * How the browser should show a Photo, by its MIME type as ExifTool reads it.
 * A HEIC, given as its upright pixels, is converted here and returned inline,
 * since the server keeps nothing (ADR-0001). TIFF and RAW have no preview in v1.
 */
export function previewFor(mimeType: string, uprightHeic?: Pixels): Preview {
  if (isHeic(mimeType) && uprightHeic) {
    const { width, height, data } = uprightHeic;
    const encoded = jpeg.encode({ width, height, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }, 90);
    return { kind: "converted", mimeType: "image/jpeg", base64: encoded.data.toString("base64") };
  }
  if (BROWSER_TYPES.has(mimeType)) return { kind: "client" };
  return { kind: "none" };
}

/** Turns RGBA pixels the way an EXIF Orientation (1 to 8) says to view them. */
function applyExifOrientation({ width, height, data }: Pixels, orientation: number): Pixels {
  if (orientation < 2 || orientation > 8) return { width, height, data };
  const swaps = orientation >= 5;
  const out = { width: swaps ? height : width, height: swaps ? width : height };
  // For each pixel of the upright image, where it sits in the stored one.
  const source: Record<number, (x: number, y: number) => [number, number]> = {
    2: (x, y) => [width - 1 - x, y],
    3: (x, y) => [width - 1 - x, height - 1 - y],
    4: (x, y) => [x, height - 1 - y],
    5: (x, y) => [y, x],
    6: (x, y) => [y, height - 1 - x],
    7: (x, y) => [width - 1 - y, height - 1 - x],
    8: (x, y) => [width - 1 - y, x],
  };
  const from = source[orientation]!;
  const pixels = new Uint8ClampedArray(data.length);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const [sx, sy] = from(x, y);
      const s = (sy * width + sx) * 4;
      pixels.set(data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return { ...out, data: pixels };
}

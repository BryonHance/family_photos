import convertHeic from "heic-convert";
import type { Preview } from "../shared/analysis.ts";

/** Formats every browser can show from its own copy of the file. */
const BROWSER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

/**
 * How the browser should show a Photo, by its MIME type as ExifTool reads it.
 * HEIC is converted here and returned inline, since the server keeps nothing (ADR-0001).
 * TIFF and RAW have no preview in v1.
 */
export async function previewFor(mimeType: string, bytes: Uint8Array): Promise<Preview> {
  if (HEIC_TYPES.has(mimeType)) {
    // libheif applies the HEIF rotation and mirroring (irot/imir), which is how an
    // iPhone records orientation, so the JPEG comes out upright. The EXIF
    // Orientation a HEIC also carries describes that same turn, so applying it as
    // well would rotate the Photo twice.
    const jpeg = await convertHeic({ buffer: bytes, format: "JPEG", quality: 0.9 });
    return { kind: "converted", mimeType: "image/jpeg", base64: Buffer.from(jpeg).toString("base64") };
  }
  if (BROWSER_TYPES.has(mimeType)) return { kind: "client" };
  return { kind: "none" };
}

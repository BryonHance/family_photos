import sharp from "sharp";
import type { Pixels } from "./pixels.ts";

/**
 * A Photo as the face and pet pipelines receive it: either an encoded JPEG, PNG
 * or WebP that sharp decodes and turns upright by its EXIF Orientation, or raw
 * pixels already upright (a HEIC decoded by heic-decode, or a Photo decoded here).
 */
export type PhotoPixels = { kind: "encoded"; bytes: Uint8Array } | ({ kind: "raw" } & Pixels);

/**
 * The upright Photo is decoded at most this size on its long side: enough
 * pixels to align a Face found at 640 px, without holding a 48 MP Photo in memory.
 */
const MAX_DECODED_SIDE = 2048;

/**
 * The upright Photo as RGB, at most MAX_DECODED_SIDE on its long side, decoded
 * once and shared by the face and pet pipelines. Raw RGB pixels already that
 * small come back as they are. Undefined when the Photo cannot be decoded at
 * all; a Photo that is only partly damaged is decoded as far as it goes.
 */
export async function decodeUpright(photo: PhotoPixels): Promise<Pixels<3> | undefined> {
  if (photo.kind === "raw" && photo.channels === 3 && Math.max(photo.width, photo.height) <= MAX_DECODED_SIDE) {
    return { width: photo.width, height: photo.height, channels: 3, data: photo.data };
  }
  const image =
    photo.kind === "encoded"
      ? sharp(photo.bytes, { failOn: "none" }).autoOrient()
      : sharp(photo.data, { raw: { width: photo.width, height: photo.height, channels: photo.channels } });
  try {
    const { data, info } = await image
      .resize(MAX_DECODED_SIDE, MAX_DECODED_SIDE, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: 3, data };
  } catch {
    return undefined;
  }
}

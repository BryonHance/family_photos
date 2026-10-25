import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { Analysis, Face, Field, Section, SectionName, Summary } from "../shared/analysis.ts";
import type { FaceDetector, PhotoPixels } from "./faces/detector.ts";
import type { FaceStore } from "./faces/store.ts";
import type { Pixels } from "./pixels.ts";
import { decodeUprightHeic, isHeic, previewFor } from "./preview.ts";
import {
  DATE_TAKEN,
  DATE_TAKEN_OFFSET,
  isLongTag,
  numericValue,
  parseGroupKey,
  printedValue,
  type GroupKey,
  type LongTag,
  type Tags,
} from "./tags.ts";
import { deriveWarnings, STRUCTURAL_WARNINGS_ONLY } from "./warnings.ts";

export type AnalyzerConfig = {
  exiftool: ExifTool;
  /** Where a Photo sits while ExifTool reads it. Emptied after every analysis (ADR-0001). */
  tempDir: string;
  /** Finds the Faces in each Photo and computes their embeddings. */
  faceDetector: FaceDetector;
  /** Keeps each Face's box, embedding and Person, by the Photo's hash, and never the Photo (ADR-0002). */
  faceStore: FaceStore;
};

export type PhotoUpload = {
  bytes: Uint8Array;
  name: string;
  /** The file's modified time in milliseconds since the epoch, when the browser sent it. */
  lastModified?: number;
};

/** The file was read but is not a Photo the viewer supports, such as a PDF or a video. */
export class UnsupportedFileError extends Error {
  readonly mimeType: string;

  constructor(mimeType: string) {
    super(`Not a supported Photo: ${mimeType}`);
    this.mimeType = mimeType;
  }
}

// ExifTool family-0 groups, mapped to the Section they belong in. Groups from
// the seven standards map directly; groups outside them go in the nearest one.
// Every group a Photo is known to carry is listed, so nothing reaches File by
// accident: only a group ExifTool adds that is not listed here falls back to File.
const SECTION_BY_GROUP: Record<string, SectionName> = {
  // File-level facts: type, size, dimensions, and the JPEG comment (COM).
  File: "File",
  EXIF: "EXIF",
  IPTC: "IPTC",
  XMP: "XMP",
  ICC_Profile: "ICC",
  MakerNotes: "Maker notes",
  // MPF (Multi-Picture Format) is a CIPA extension stored beside EXIF.
  MPF: "EXIF",
  // Photoshop's image resource block is the usual carrier of IPTC.
  Photoshop: "IPTC",
  // Containers and file-format structure, which describe the file, not the Photo:
  JFIF: "File", // JPEG's APP0 header (density, version)
  JFXX: "File", // JFIF extension (thumbnail)
  APP14: "File", // Adobe's JPEG colour-transform marker
  Ducky: "File", // Photoshop "Save for Web" quality marker (APP12)
  FlashPix: "File", // FlashPix extension segments (APP2)
  PrintIM: "File", // Epson print-matching block
  JUMBF: "File", // JPEG universal metadata box format (C2PA manifests)
  QuickTime: "File", // HEIF/HEIC boxes (item info, dimensions, irot)
  RIFF: "File", // WebP's RIFF container (VP8 header, dimensions)
  PNG: "File", // PNG chunks; text chunks are routed to XMP in sectionFor
};

/**
 * Tags in ExifTool's PNG group that come from PNG's structural chunks (IHDR,
 * cHRM, gAMA, tIME and the rest). Every other PNG-group tag comes from a text
 * chunk (tEXt, iTXt or zTXt), whose keywords are open-ended, so those are the
 * ones that cannot be listed. pHYs and cICP have their own family-1 groups.
 */
const PNG_STRUCTURE_TAGS = new Set([
  // IHDR
  "ImageWidth",
  "ImageHeight",
  "BitDepth",
  "ColorType",
  "Compression",
  "Filter",
  "Interlace",
  // cHRM
  "WhitePointX",
  "WhitePointY",
  "RedX",
  "RedY",
  "GreenX",
  "GreenY",
  "BlueX",
  "BlueY",
  // sCAL, vpAg, sTER, acTL
  "SubjectUnits",
  "SubjectPixelWidth",
  "SubjectPixelHeight",
  "VirtualImageWidth",
  "VirtualImageHeight",
  "VirtualPageUnits",
  "StereoMode",
  "AnimationFrames",
  "AnimationPlays",
  // Single-value chunks
  "BackgroundColor",
  "DigitalSignature",
  "FractalParameters",
  "Gamma",
  "GIFGraphicControlExtension",
  "GIFPlainTextExtension",
  "GIFApplicationExtension",
  "PaletteHistogram",
  "ProfileName",
  "ImageOffset",
  "PixelCalibration",
  "Palette",
  "SignificantBits",
  "SuggestedPalette",
  "SRGBRendering",
  "ModifyDate",
  "Transparency",
  "AppleDataOffsets",
  "GainMapImage",
]);

/**
 * Groups whose tags are not Fields of the Photo: Composite tags are derived by
 * ExifTool, not read from the Photo; ExifTool reports its own version and
 * warnings; System describes the server's temporary copy.
 */
const IGNORED_GROUPS = new Set(["Composite", "ExifTool", "System"]);

function sectionFor({ family0, family1, tag }: GroupKey): SectionName | undefined {
  if (IGNORED_GROUPS.has(family0) || IGNORED_GROUPS.has(family1)) return undefined;
  if (family0 === "EXIF" && family1 === "GPS") return "GPS";
  // PNG text chunks are the PNG format's own descriptive metadata, the nearest fit being XMP.
  if (family0 === "PNG" && family1 === "PNG" && !PNG_STRUCTURE_TAGS.has(tag)) return "XMP";
  return SECTION_BY_GROUP[family0] ?? "File";
}

const SECTION_ORDER: SectionName[] = ["File", "EXIF", "GPS", "IPTC", "XMP", "ICC", "Maker notes"];

export async function analyzePhoto(config: AnalyzerConfig, photo: PhotoUpload): Promise<Analysis> {
  const tags = await readTags(config, photo.bytes);
  const photoMimeType = printedValue(tags, "File:MIMEType") ?? "application/octet-stream";
  if (!photoMimeType.startsWith("image/")) throw new UnsupportedFileError(photoMimeType);

  const fieldsBySection = new Map<SectionName, Field[]>();
  for (const [key, value] of Object.entries(tags)) {
    const groupKey = parseGroupKey(key);
    const sectionName = groupKey && sectionFor(groupKey);
    if (!groupKey || !sectionName || !isLongTag(value)) continue;
    const fields = fieldsBySection.get(sectionName) ?? [];
    fields.push(toField(groupKey.tag, value));
    fieldsBySection.set(sectionName, fields);
  }
  fieldsBySection.set("File", [...uploadFields(tags, photo), ...(fieldsBySection.get("File") ?? [])]);

  const sections: Section[] = SECTION_ORDER.flatMap((name) => {
    const fields = fieldsBySection.get(name);
    return fields ? [{ name, fields }] : [];
  });

  // A HEIC is decoded once, for both its preview and its Faces.
  const uprightHeic = isHeic(photoMimeType)
    ? await decodeUprightHeic(photo.bytes, {
        exif: numericValue(tags, "EXIF:IFD0:Orientation"),
        heifTransform: "QuickTime:Rotation" in tags || "QuickTime:Mirroring" in tags,
      })
    : undefined;

  return {
    photo: { name: photo.name, sizeBytes: photo.bytes.byteLength, mimeType: photoMimeType },
    preview: previewFor(photoMimeType, uprightHeic),
    warnings: deriveWarnings(tags, sections, photo.lastModified),
    summary: summarize(tags),
    sections,
    faces: await findFaces(config, photoMimeType, photo.bytes, uprightHeic),
  };
}

/** Formats sharp decodes, turning them upright by their EXIF Orientation. */
const SHARP_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * A Photo seen before, under the same model version, returns its stored Faces
 * without being detected again. JPEG, PNG and WebP go to sharp; a HEIC arrives
 * already decoded. TIFF and RAW get no Faces.
 */
async function findFaces(
  { faceDetector, faceStore }: AnalyzerConfig,
  mimeType: string,
  bytes: Uint8Array,
  uprightHeic: Pixels<4> | undefined,
): Promise<Face[]> {
  const pixels: PhotoPixels | undefined = uprightHeic
    ? { kind: "raw", ...uprightHeic }
    : SHARP_TYPES.has(mimeType)
      ? { kind: "encoded", bytes }
      : undefined;
  if (!pixels) return [];
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return faceStore.facesOfPhoto({ sha256, modelVersion: faceDetector.modelVersion }, async () =>
    (await faceDetector.detect(pixels)).map(({ box, embedding }) => ({ box, embedding })),
  );
}

/**
 * Fields describing the uploaded file. ExifTool's System group describes the
 * server's temporary copy (its name, directory, times, permissions), so only the
 * file size carries over; the name and modified time come from the upload.
 */
function uploadFields(tags: Tags, { name, lastModified }: PhotoUpload): Field[] {
  const fields: Field[] = [{ tag: "FileName", label: "File Name", raw: name }];
  const fileSize = tags["File:System:FileSize"];
  if (isLongTag(fileSize)) fields.push(toField("FileSize", fileSize));
  const modified = lastModified === undefined ? undefined : exifToolDate(lastModified);
  if (lastModified !== undefined && modified !== undefined) {
    fields.push({ tag: "FileModifyDate", label: "File Modification Date/Time", raw: lastModified, display: modified });
  }
  return fields;
}

/** A time in ExifTool's date format, in UTC ("2024:07:05 01:30:00+00:00"), or undefined if it is not a valid time. */
function exifToolDate(ms: number): string | undefined {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString(); // "2024-07-05T01:30:00.000Z"
  return `${iso.slice(0, 10).replaceAll("-", ":")} ${iso.slice(11, 19)}+00:00`;
}

/** The Summary is read from the Fields as ExifTool prints them; absent Fields are omitted, never guessed. */
function summarize(tags: Tags): Summary {
  const printed = (key: string) => printedValue(tags, key);

  const make = printed("EXIF:IFD0:Make");
  const model = printed("EXIF:IFD0:Model");
  // Cameras often repeat the make in the model ("Canon" + "Canon EOS R6").
  const camera = model && make && !model.startsWith(make) ? `${make} ${model}` : (model ?? make);

  const fNumber = printed("EXIF:ExifIFD:FNumber");
  const exposure = definedOnly({
    shutter: printed("EXIF:ExifIFD:ExposureTime"),
    aperture: fNumber === undefined ? undefined : `f/${fNumber}`,
    iso: printed("EXIF:ExifIFD:ISO"),
    focalLength: printed("EXIF:ExifIFD:FocalLength"),
  });

  return definedOnly({
    dateTaken: printed(DATE_TAKEN),
    timezone: printed(DATE_TAKEN_OFFSET),
    camera,
    lens: printed("EXIF:ExifIFD:LensModel"),
    exposure: Object.keys(exposure).length > 0 ? exposure : undefined,
    location: location({
      latitude: numericValue(tags, "EXIF:GPS:GPSLatitude"),
      latitudeRef: printed("EXIF:GPS:GPSLatitudeRef"),
      longitude: numericValue(tags, "EXIF:GPS:GPSLongitude"),
      longitudeRef: printed("EXIF:GPS:GPSLongitudeRef"),
    }),
  });
}

type GpsFields = { latitude?: number; latitudeRef?: string; longitude?: number; longitudeRef?: string };

/** GPS coordinates are stored unsigned, with the hemisphere in a separate reference Field. */
function location({ latitude, latitudeRef, longitude, longitudeRef }: GpsFields): Summary["location"] {
  if (latitude === undefined || longitude === undefined) return undefined;
  return {
    latitude: latitudeRef?.startsWith("S") ? -Math.abs(latitude) : latitude,
    longitude: longitudeRef?.startsWith("W") ? -Math.abs(longitude) : longitude,
  };
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** ExifTool reads from disk, so the Photo is written to a temporary file that never outlives the read. */
async function readTags({ exiftool, tempDir }: AnalyzerConfig, bytes: Uint8Array): Promise<Tags> {
  const path = join(tempDir, randomUUID());
  try {
    await writeFile(path, bytes);
    return (await exiftool.readRaw(path, {
      readArgs: ["-l", "-G0:1", "-a", ...STRUCTURAL_WARNINGS_ONLY],
    })) as Tags;
  } finally {
    await rm(path, { force: true });
  }
}

function toField(tag: string, { desc, val, num }: LongTag): Field {
  if (num === undefined || String(num) === String(val)) return { tag, label: desc, raw: val };
  return { tag, label: desc, raw: num, display: String(val) };
}

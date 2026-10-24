import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { Analysis, Field, Section, SectionName, Summary } from "../shared/analysis.ts";
import { previewFor } from "./preview.ts";
import { deriveWarnings, STRUCTURAL_WARNINGS_ONLY } from "./warnings.ts";

export type AnalyzerConfig = {
  exiftool: ExifTool;
  /** Where a Photo sits while ExifTool reads it. Emptied after every analysis (ADR-0001). */
  tempDir: string;
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

/** One entry of ExifTool's long (`-l`) JSON output. */
type LongTag = { desc: string; val: string | number; num?: string | number };

// ExifTool family-0 groups, mapped to the Section they belong in. Container
// groups outside the seven Sections go in the nearest one: JFIF and other
// file-format structure in File, MPF (a CIPA extension stored beside EXIF) in
// EXIF, and Photoshop's resource block (which carries IPTC) in IPTC. Any group
// not listed here describes the file's structure, so it falls back to File.
const SECTION_BY_GROUP: Record<string, SectionName> = {
  File: "File",
  JFIF: "File",
  EXIF: "EXIF",
  MPF: "EXIF",
  IPTC: "IPTC",
  Photoshop: "IPTC",
  XMP: "XMP",
  ICC_Profile: "ICC",
  MakerNotes: "Maker notes",
};

/**
 * Groups whose tags are not Fields of the Photo: Composite tags are derived by
 * ExifTool, not read from the Photo; ExifTool reports its own version; System
 * describes the server's temporary copy.
 */
const IGNORED_GROUPS = new Set(["Composite", "ExifTool", "System"]);

function sectionFor(family0: string, family1: string): SectionName | undefined {
  if (IGNORED_GROUPS.has(family0) || IGNORED_GROUPS.has(family1)) return undefined;
  if (family0 === "EXIF" && family1 === "GPS") return "GPS";
  return SECTION_BY_GROUP[family0] ?? "File";
}

const SECTION_ORDER: SectionName[] = ["File", "EXIF", "GPS", "IPTC", "XMP", "ICC", "Maker notes"];

export async function analyzePhoto(config: AnalyzerConfig, photo: PhotoUpload): Promise<Analysis> {
  const tags = await readTags(config, photo.bytes);
  const type = mimeType(tags["File:MIMEType"]);
  if (!type.startsWith("image/")) throw new UnsupportedFileError(type);

  const fieldsBySection = new Map<SectionName, Field[]>();
  for (const [key, value] of Object.entries(tags)) {
    // Keys are "Family0:Family1:Tag", or "Group:Tag" when both families agree.
    const parts = key.split(":");
    const tag = parts.at(-1);
    const family0 = parts[0] ?? "";
    const family1 = parts.length > 2 ? (parts[1] ?? "") : family0;
    const sectionName = sectionFor(family0, family1);
    if (!sectionName || !tag || parts.length < 2 || !isLongTag(value)) continue;
    const fields = fieldsBySection.get(sectionName) ?? [];
    fields.push(toField(tag, value));
    fieldsBySection.set(sectionName, fields);
  }

  // ExifTool's System group describes the server's temporary copy (its name,
  // directory, permissions), so only the file size carries over; the name comes
  // from the upload.
  const uploadFields: Field[] = [{ tag: "FileName", label: "File Name", raw: photo.name }];
  const fileSize = tags["File:System:FileSize"];
  if (isLongTag(fileSize)) uploadFields.push(toField("FileSize", fileSize));
  fieldsBySection.set("File", [...uploadFields, ...(fieldsBySection.get("File") ?? [])]);

  const sections: Section[] = SECTION_ORDER.flatMap((name) => {
    const fields = fieldsBySection.get(name);
    return fields ? [{ name, fields }] : [];
  });

  return {
    photo: { name: photo.name, sizeBytes: photo.bytes.byteLength, mimeType: type },
    preview: await previewFor(type, photo.bytes),
    warnings: deriveWarnings(tags, photo.lastModified),
    summary: summarize(tags),
    sections,
  };
}

type Tags = Record<string, unknown>;

/** The Summary is read from the Fields as ExifTool prints them; absent Fields are omitted, never guessed. */
function summarize(tags: Tags): Summary {
  const printed = (key: string) => {
    const tag = tags[key];
    return isLongTag(tag) ? String(tag.val) : undefined;
  };
  const numeric = (key: string) => {
    const tag = tags[key];
    if (!isLongTag(tag)) return undefined;
    const value = Number(tag.num ?? tag.val);
    return Number.isFinite(value) ? value : undefined;
  };

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
    dateTaken: printed("EXIF:ExifIFD:DateTimeOriginal"),
    timezone: printed("EXIF:ExifIFD:OffsetTimeOriginal"),
    camera,
    lens: printed("EXIF:ExifIFD:LensModel"),
    exposure: Object.keys(exposure).length > 0 ? exposure : undefined,
    location: location(
      numeric("EXIF:GPS:GPSLatitude"),
      printed("EXIF:GPS:GPSLatitudeRef"),
      numeric("EXIF:GPS:GPSLongitude"),
      printed("EXIF:GPS:GPSLongitudeRef"),
    ),
  });
}

/** GPS coordinates are stored unsigned, with the hemisphere in a separate reference Field. */
function location(latitude?: number, latitudeRef?: string, longitude?: number, longitudeRef?: string) {
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
async function readTags({ exiftool, tempDir }: AnalyzerConfig, bytes: Uint8Array) {
  const path = join(tempDir, randomUUID());
  try {
    await writeFile(path, bytes);
    return (await exiftool.readRaw(path, { readArgs: ["-l", "-G0:1", "-a", ...STRUCTURAL_WARNINGS_ONLY] })) as Record<string, unknown>;
  } finally {
    await rm(path, { force: true });
  }
}

function toField(tag: string, { desc, val, num }: LongTag): Field {
  if (num === undefined || String(num) === String(val)) return { tag, label: desc, raw: val };
  return { tag, label: desc, raw: num, display: String(val) };
}

function mimeType(value: unknown): string {
  return isLongTag(value) ? String(value.val) : "application/octet-stream";
}

function isLongTag(value: unknown): value is LongTag {
  return typeof value === "object" && value !== null && "desc" in value && "val" in value;
}

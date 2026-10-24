import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { Analysis, Field, Section, SectionName, Summary } from "../shared/analysis.ts";

export type AnalyzerConfig = {
  exiftool: ExifTool;
  /** Where a Photo sits while ExifTool reads it. Emptied after every analysis (ADR-0001). */
  tempDir: string;
};

export type PhotoUpload = { bytes: Uint8Array; name: string };

/** One entry of ExifTool's long (`-l`) JSON output. */
type LongTag = { desc: string; val: string | number; num?: string | number };

// ExifTool family-1 groups, mapped to the Section they belong in.
const SECTION_BY_GROUP: Record<string, SectionName> = {
  File: "File",
  IFD0: "EXIF",
  IFD1: "EXIF",
  ExifIFD: "EXIF",
  SubIFD: "EXIF",
  InteropIFD: "EXIF",
};

const SECTION_ORDER: SectionName[] = ["File", "EXIF", "GPS", "IPTC", "XMP", "ICC", "Maker notes"];

export async function analyzePhoto(config: AnalyzerConfig, photo: PhotoUpload): Promise<Analysis> {
  const tags = await readTags(config, photo.bytes);

  const fieldsBySection = new Map<SectionName, Field[]>();
  for (const [key, value] of Object.entries(tags)) {
    const [group, tag] = key.split(":");
    const sectionName = group ? SECTION_BY_GROUP[group] : undefined;
    if (!sectionName || !tag || !isLongTag(value)) continue;
    const fields = fieldsBySection.get(sectionName) ?? [];
    fields.push(toField(tag, value));
    fieldsBySection.set(sectionName, fields);
  }

  // ExifTool's System group describes the server's temporary copy (its name,
  // directory, permissions), so only the file size carries over; the name comes
  // from the upload.
  const uploadFields: Field[] = [{ tag: "FileName", label: "File Name", raw: photo.name }];
  const fileSize = tags["System:FileSize"];
  if (isLongTag(fileSize)) uploadFields.push(toField("FileSize", fileSize));
  fieldsBySection.set("File", [...uploadFields, ...(fieldsBySection.get("File") ?? [])]);

  const sections: Section[] = SECTION_ORDER.flatMap((name) => {
    const fields = fieldsBySection.get(name);
    return fields ? [{ name, fields }] : [];
  });

  return {
    photo: { name: photo.name, sizeBytes: photo.bytes.byteLength, mimeType: mimeType(tags["File:MIMEType"]) },
    preview: { kind: "client" },
    warnings: [],
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

  const make = printed("IFD0:Make");
  const model = printed("IFD0:Model");
  // Cameras often repeat the make in the model ("Canon" + "Canon EOS R6").
  const camera = model && make && !model.startsWith(make) ? `${make} ${model}` : (model ?? make);

  const fNumber = printed("ExifIFD:FNumber");
  const exposure = definedOnly({
    shutter: printed("ExifIFD:ExposureTime"),
    aperture: fNumber === undefined ? undefined : `f/${fNumber}`,
    iso: printed("ExifIFD:ISO"),
    focalLength: printed("ExifIFD:FocalLength"),
  });

  return definedOnly({
    dateTaken: printed("ExifIFD:DateTimeOriginal"),
    timezone: printed("ExifIFD:OffsetTimeOriginal"),
    camera,
    lens: printed("ExifIFD:LensModel"),
    exposure: Object.keys(exposure).length > 0 ? exposure : undefined,
    location: location(
      numeric("GPS:GPSLatitude"),
      printed("GPS:GPSLatitudeRef"),
      numeric("GPS:GPSLongitude"),
      printed("GPS:GPSLongitudeRef"),
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
    return (await exiftool.readRaw(path, { readArgs: ["-l", "-G1", "-a"] })) as Record<string, unknown>;
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

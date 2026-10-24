import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { Analysis, Field, Section, SectionName } from "../shared/analysis.ts";
import { deriveWarnings } from "./warnings.ts";

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
    warnings: deriveWarnings(tags, photo.lastModified),
    summary: {},
    sections,
  };
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

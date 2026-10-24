import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { Analysis, Field, Section, SectionName } from "../shared/analysis.ts";

export type AnalyzerConfig = {
  exiftool: ExifTool;
  /** Where a Photo sits while ExifTool reads it. Emptied after every analysis (ADR-0001). */
  tempDir: string;
};

export type PhotoUpload = { bytes: Uint8Array; name: string };

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
    photo: { name: photo.name, sizeBytes: photo.bytes.byteLength, mimeType: mimeType(tags["File:MIMEType"]) },
    preview: { kind: "client" },
    warnings: [],
    summary: {},
    sections,
  };
}

/** ExifTool reads from disk, so the Photo is written to a temporary file that never outlives the read. */
async function readTags({ exiftool, tempDir }: AnalyzerConfig, bytes: Uint8Array) {
  const path = join(tempDir, randomUUID());
  try {
    await writeFile(path, bytes);
    return (await exiftool.readRaw(path, { readArgs: ["-l", "-G0:1", "-a"] })) as Record<string, unknown>;
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

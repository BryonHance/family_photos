import type { Section, SectionName, Warning } from "../shared/analysis.ts";
import { DATE_TAKEN, DATE_TAKEN_OFFSET, rawValue, type Tags } from "./tags.ts";

// The Sections that come from EXIF (GPS is part of it), IPTC or XMP. File and
// ICC describe the file and its colour profile, so they do not count.
const METADATA_SECTIONS = new Set<SectionName>(["EXIF", "GPS", "IPTC", "XMP"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ExifTool warnings that are about the file's structure: truncation, format
 * errors, and corrupt or bad segments, chunks, IFDs and offsets. Other warnings,
 * such as an unknown text encoding in one Field, say nothing about whether the
 * Photo is damaged. ("[minor]" warnings never get this far: exiftool-vendored
 * reads with -ignoreMinorErrors, and they are skipped below as well.)
 */
const STRUCTURAL_PROBLEM =
  /format error|truncat|corrupt|unexpected end|end of file|error (?:reading|processing)|incomplete|not a valid|\bbad\b|invalid (?:offset|magic|TIFF|.*(?:segment|chunk|IFD|directory|header|size|length))|(?:IFD|segment|chunk|directory).*(?:loop|overlap|missing|references)/i;

/**
 * ExifTool's JSON carries only its first Warning, so a warning about one Field
 * could hide a later one about the file's structure. These read arguments have
 * ExifTool drop every warning that is not structural (its NoWarning option takes
 * a Perl regular expression).
 */
export const STRUCTURAL_WARNINGS_ONLY = ["-api", `NoWarning=(?i)^(?!.*(?:${STRUCTURAL_PROBLEM.source}))`];

/**
 * @param sections The Photo's Sections, which decide whether it has any metadata.
 * @param lastModified The file's modified time as the browser reported it, in
 *   milliseconds since the epoch; the Date mismatch check is skipped without it.
 */
export function deriveWarnings(tags: Tags, sections: Section[], lastModified: number | undefined): Warning[] {
  const warnings: Warning[] = [];

  if (!sections.some((section) => METADATA_SECTIONS.has(section.name))) {
    warnings.push({
      kind: "no-metadata",
      message: "This Photo has no EXIF, IPTC or XMP metadata. A messaging app or social site has probably stripped it.",
    });
  } else {
    if (!(DATE_TAKEN in tags)) {
      warnings.push({
        kind: "no-date-taken",
        message: "This Photo has no Date taken, so it may sort out of order in albums.",
      });
    } else {
      const takenAt = dateTakenMs(tags);
      if (takenAt !== undefined && lastModified !== undefined && Math.abs(takenAt - lastModified) > DAY_MS) {
        warnings.push({
          kind: "date-mismatch",
          message: "The Date taken and the file's modified time are more than a day apart, so one of them may be wrong.",
        });
      }
    }
  }

  // ExifTool reports trouble reading the file in its own Error and Warning tags,
  // and still returns whatever it could read. Every Error counts; a Warning
  // counts only when it is about the file's structure.
  const warning = text(tags, "ExifTool:Warning");
  const structuralWarning = !warning.startsWith("[minor]") && STRUCTURAL_PROBLEM.test(warning) ? warning : "";
  const problem = text(tags, "ExifTool:Error") || structuralWarning;
  if (problem) {
    warnings.push({
      kind: "damaged-file",
      message: `This Photo looks damaged or incomplete (ExifTool: "${problem}"), so some Fields may be missing.`,
    });
  }

  return warnings;
}

/**
 * The Date taken as milliseconds since the epoch. ExifTool writes it as
 * "YYYY:MM:DD HH:MM:SS", with the offset in OffsetTimeOriginal. A Date taken
 * with no recorded offset is read as UTC; the 24-hour tolerance absorbs that.
 */
function dateTakenMs(tags: Tags): number | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/.exec(
    text(tags, DATE_TAKEN) + text(tags, DATE_TAKEN_OFFSET),
  );
  if (!match) return undefined;
  const [, y, mo, d, h, mi, sec = "00", offset = "Z"] = match;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${offset}`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A tag's Raw value as trimmed text, or "" when it is absent. */
function text(tags: Tags, key: string): string {
  return String(rawValue(tags, key) ?? "").trim();
}

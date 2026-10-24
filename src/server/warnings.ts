import type { Warning } from "../shared/analysis.ts";

/** ExifTool's `-G1` output: "Group:Tag" keys, each a long (`-l`) tag. */
export type RawTags = Record<string, unknown>;

// Family-1 groups that come from one of the metadata standards. File and ICC
// describe the file and its colour profile, so they do not count.
const isMetadataGroup = (group: string) =>
  /^(IFD\d|ExifIFD|SubIFD\d*|InteropIFD|GPS|IPTC|XMP(-.*)?)$/.test(group);

// The Date taken is EXIF's DateTimeOriginal, with its timezone from
// OffsetTimeOriginal: the same rule the Summary uses, so the two agree.
const DATE_TAKEN = "ExifIFD:DateTimeOriginal";
const DATE_TAKEN_OFFSET = "ExifIFD:OffsetTimeOriginal";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param lastModified The file's modified time as the browser reported it, in
 *   milliseconds since the epoch; the Date mismatch check is skipped without it.
 */
export function deriveWarnings(tags: RawTags, lastModified: number | undefined): Warning[] {
  const groups = new Set(Object.keys(tags).map((key) => key.split(":")[0] ?? ""));
  const warnings: Warning[] = [];

  if (![...groups].some(isMetadataGroup)) {
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

  // ExifTool reports trouble reading the file's structure in its own Error and
  // Warning tags, and still returns whatever it could read.
  const problem = rawText(tags["ExifTool:Error"]) || rawText(tags["ExifTool:Warning"]);
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
function dateTakenMs(tags: RawTags): number | undefined {
  const text = rawText(tags[DATE_TAKEN]) + rawText(tags[DATE_TAKEN_OFFSET]);

  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?/.exec(text);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, sec = "00", offset = "Z"] = match;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${offset}`);
  return Number.isNaN(ms) ? undefined : ms;
}

function rawText(tag: unknown): string {
  if (typeof tag !== "object" || tag === null || !("val" in tag)) return "";
  const { val, num } = tag as { val: unknown; num?: unknown };
  return String(num ?? val).trim();
}

// Reading ExifTool's output. The analyzer reads with `-l -G0:1 -a`, so each key is
// "Family0:Family1:Tag" (or "Group:Tag" when both families agree) and each value
// is a long tag carrying the printed value and, when it differs, the numeric one.

export type Tags = Record<string, unknown>;

/** One entry of ExifTool's long (`-l`) JSON output. */
export type LongTag = { desc: string; val: string | number; num?: string | number };

/** The Date taken: EXIF's DateTimeOriginal, with its timezone in OffsetTimeOriginal. */
export const DATE_TAKEN = "EXIF:ExifIFD:DateTimeOriginal";
export const DATE_TAKEN_OFFSET = "EXIF:ExifIFD:OffsetTimeOriginal";

export function isLongTag(value: unknown): value is LongTag {
  return typeof value === "object" && value !== null && "desc" in value && "val" in value;
}

/** A Field's Display value: ExifTool's printed output, as text. */
export function printedValue(tags: Tags, key: string): string | undefined {
  const tag = tags[key];
  return isLongTag(tag) ? String(tag.val) : undefined;
}

/** A Field's Raw value: ExifTool's numeric output where it has one, else its printed output. */
export function rawValue(tags: Tags, key: string): string | number | undefined {
  const tag = tags[key];
  return isLongTag(tag) ? (tag.num ?? tag.val) : undefined;
}

/** A Field's Raw value as a number, when it is one. */
export function numericValue(tags: Tags, key: string): number | undefined {
  const raw = rawValue(tags, key);
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) ? value : undefined;
}

export type GroupKey = { family0: string; family1: string; tag: string };

/** Splits a key into its family-0 group, family-1 group and Tag name. */
export function parseGroupKey(key: string): GroupKey | undefined {
  const parts = key.split(":");
  const [family0, second, third] = parts;
  if (parts.length === 2 && family0 && second) return { family0, family1: family0, tag: second };
  if (parts.length === 3 && family0 && second && third) return { family0, family1: second, tag: third };
  return undefined;
}

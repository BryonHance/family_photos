// The contract between the server and the browser for one analyzed Photo.
// Vocabulary follows GLOSSARY.md.

export type SectionName = "File" | "EXIF" | "GPS" | "IPTC" | "XMP" | "ICC" | "Maker notes";

export type Field = {
  /** The Field's Tag name, such as "ExposureTime". */
  tag: string;
  /** The Field's name in readable words, such as "Exposure Time". */
  label: string;
  raw: string | number;
  /** Present only when it differs from the Raw value. */
  display?: string;
};

export type Section = { name: SectionName; fields: Field[] };

export type Preview =
  | { kind: "client" }
  | { kind: "converted"; mimeType: "image/jpeg"; base64: string }
  | { kind: "none" };

export type WarningKind = "no-metadata" | "no-date-taken" | "date-mismatch" | "damaged-file";

export type Warning = { kind: WarningKind; message: string };

export type Summary = {
  dateTaken?: string;
  timezone?: string;
  camera?: string;
  lens?: string;
  exposure?: { shutter?: string; aperture?: string; iso?: string; focalLength?: string };
  location?: { latitude: number; longitude: number };
};

export type Analysis = {
  photo: { name: string; sizeBytes: number; mimeType: string };
  preview: Preview;
  warnings: Warning[];
  summary: Summary;
  sections: Section[];
};

export type AnalyzeError = { error: { kind: string; message: string } };

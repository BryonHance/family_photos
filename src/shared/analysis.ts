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

/** A rectangle in fractions of the upright Photo's width and height, from its top left. */
export type Box = { x: number; y: number; width: number; height: number };

/** A Face found in the Photo. */
export type Face = { box: Box };

export type Analysis = {
  photo: { name: string; sizeBytes: number; mimeType: string };
  preview: Preview;
  warnings: Warning[];
  summary: Summary;
  sections: Section[];
  /** Ordered left to right. Empty when there are none, and for TIFF and RAW. */
  faces: Face[];
};

export type AnalyzeErrorKind = "no-photo" | "too-large" | "unsupported-file";

export type AnalyzeError = { error: { kind: AnalyzeErrorKind; message: string } };

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

/** A Person as a Face refers to them. */
export type PersonRef = { id: string; name: string };

/**
 * A Face found in the Photo, stored so that it can be named (ADR-0002). It has
 * at most one of `person`, `suggestion` and `stranger`.
 */
export type Face = {
  id: string;
  box: Box;
  /** Present once the Face is named. */
  person?: PersonRef;
  /** Who the viewer thinks the Face shows, waiting to be confirmed or rejected. Never beside `person`. */
  suggestion?: PersonRef;
  /**
   * The Stranger an unnamed Face without a Suggestion belongs to, once that
   * Stranger spans at least 2 Photos: "Unknown 4", in `photoCount` Photos.
   */
  stranger?: StrangerRef;
};

/** A Stranger as a Face refers to them. */
export type StrangerRef = { label: string; photoCount: number };

/** A Person as the People panel lists them. */
export type PersonSummary = PersonRef & { faceCount: number };

export type Analysis = {
  photo: { name: string; sizeBytes: number; mimeType: string };
  preview: Preview;
  warnings: Warning[];
  summary: Summary;
  sections: Section[];
  /** Ordered left to right. Empty when there are none, and for TIFF and RAW. Faces marked "Not a face" are left out. */
  faces: Face[];
};

export type AnalyzeErrorKind = "no-photo" | "too-large" | "unsupported-file";

export type AnalyzeError = { error: { kind: AnalyzeErrorKind; message: string } };

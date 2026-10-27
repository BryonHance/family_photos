/** Which Photo, by the SHA-256 of its file, and which models read it: the face models or the pet models. */
export type PhotoKey = { sha256: string; modelVersion: string };

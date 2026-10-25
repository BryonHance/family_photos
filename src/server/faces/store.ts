import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Box, PersonRef } from "../../shared/analysis.ts";

/**
 * faces.db holds face data and nothing else (ADR-0002): per Face, its box, the
 * Photo's SHA-256, the model version, its embedding and its Person or "Not a
 * face" mark; and each Person's name. Never the Photo, its name, or any image
 * of a Face. Kept in its own file so it can be wiped in one step and kept out
 * of off-server backups.
 *
 * A Face marked "Not a face" keeps only its box and the Photo's hash: its
 * embedding, Person and model version are cleared.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS faces (
    id            TEXT PRIMARY KEY,
    photo_sha256  TEXT NOT NULL,
    box_x         REAL NOT NULL,
    box_y         REAL NOT NULL,
    box_width     REAL NOT NULL,
    box_height    REAL NOT NULL,
    model_version TEXT,
    embedding     BLOB,
    person_id     TEXT REFERENCES people (id) ON DELETE SET NULL,
    not_a_face    INTEGER NOT NULL DEFAULT 0 CHECK (not_a_face IN (0, 1)),
    CHECK (not_a_face = 0 OR (embedding IS NULL AND person_id IS NULL AND model_version IS NULL)),
    CHECK (not_a_face = 1 OR (embedding IS NOT NULL AND model_version IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS faces_by_photo ON faces (photo_sha256);
  CREATE INDEX IF NOT EXISTS faces_by_person ON faces (person_id);
`;

/** A Face as the store returns it: what the Analysis shows. */
export type StoredFace = { id: string; box: Box; person?: PersonRef };

/** A Face as the detector found it, before it is stored. */
export type NewFace = { box: Box; embedding: Float32Array };

/** Which Photo, by the SHA-256 of its file, and which models read it. */
export type PhotoKey = { sha256: string; modelVersion: string };

export type FaceStore = ReturnType<typeof openFaceStore>;

/** A detected Face whose box overlaps an old one by at least this IoU inherits its Person or "Not a face" mark. */
const INHERIT_IOU = 0.5;

type FaceRow = {
  id: string;
  box_x: number;
  box_y: number;
  box_width: number;
  box_height: number;
  model_version: string | null;
  person_id: string | null;
  person_name: string | null;
  not_a_face: number;
};

/** Opens (or creates) faces.db at `path`; `":memory:"` keeps it in memory. */
export function openFaceStore(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const facesOfPhotoQuery = db.prepare(`
    SELECT faces.id, box_x, box_y, box_width, box_height, model_version, person_id, not_a_face,
           people.name AS person_name
    FROM faces LEFT JOIN people ON people.id = faces.person_id
    WHERE photo_sha256 = ?
    ORDER BY box_x`);
  const insertFace = db.prepare(`
    INSERT INTO faces (id, photo_sha256, box_x, box_y, box_width, box_height, model_version, embedding, person_id, not_a_face)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteFacesOfPhoto = db.prepare("DELETE FROM faces WHERE photo_sha256 = ?");

  const rowsOf = (sha256: string) => facesOfPhotoQuery.all(sha256) as FaceRow[];
  // Faces marked "Not a face" carry no model version, so they never make a Photo stale.
  const isCurrent = (rows: FaceRow[], modelVersion: string) =>
    rows.length > 0 && rows.every((r) => r.model_version === null || r.model_version === modelVersion);

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    /**
     * The Faces of a Photo, left to right, without those marked "Not a face".
     * A Photo stored under the same model version returns its stored Faces and
     * `detect` is not called. Otherwise `detect` runs and its Faces replace any
     * stored ones, each inheriting the Person or "Not a face" mark of an old
     * Face whose box it mostly overlaps.
     */
    async facesOfPhoto(photo: PhotoKey, detect: () => Promise<NewFace[]>): Promise<StoredFace[]> {
      const stored = rowsOf(photo.sha256);
      if (isCurrent(stored, photo.modelVersion)) return visible(stored);
      const detected = await detect();
      return transaction(() => {
        const old = rowsOf(photo.sha256);
        // Another request for the same Photo may have stored it while this one was detecting.
        if (isCurrent(old, photo.modelVersion)) return visible(old);
        const heirs = inheritMarks(old, detected);
        deleteFacesOfPhoto.run(photo.sha256);
        detected.forEach((face, i) => {
          const from = heirs[i];
          const notAFace = from?.not_a_face === 1;
          insertFace.run(
            randomUUID(),
            photo.sha256,
            face.box.x,
            face.box.y,
            face.box.width,
            face.box.height,
            notAFace ? null : photo.modelVersion,
            notAFace ? null : new Uint8Array(face.embedding.buffer, face.embedding.byteOffset, face.embedding.byteLength),
            notAFace ? null : (from?.person_id ?? null),
            notAFace ? 1 : 0,
          );
        });
        return visible(rowsOf(photo.sha256));
      });
    },

    close: () => db.close(),
  };
}

function visible(rows: FaceRow[]): StoredFace[] {
  return rows
    .filter((r) => r.not_a_face === 0)
    .map((r) => {
      const face: StoredFace = { id: r.id, box: boxOf(r) };
      if (r.person_id !== null && r.person_name !== null) face.person = { id: r.person_id, name: r.person_name };
      return face;
    });
}

const boxOf = (r: FaceRow): Box => ({ x: r.box_x, y: r.box_y, width: r.box_width, height: r.box_height });

/**
 * For each detected Face, the old Face it inherits from: the pairs that overlap
 * most are matched first, and each old Face passes its mark to one new Face at most.
 */
function inheritMarks(old: FaceRow[], detected: NewFace[]): (FaceRow | undefined)[] {
  const pairs = detected
    .flatMap((face, i) => old.map((row) => ({ i, row, overlap: iou(face.box, boxOf(row)) })))
    .filter((p) => p.overlap >= INHERIT_IOU)
    .sort((a, b) => b.overlap - a.overlap);
  const heirs: (FaceRow | undefined)[] = detected.map(() => undefined);
  const used = new Set<string>();
  for (const { i, row } of pairs) {
    if (heirs[i] || used.has(row.id)) continue;
    heirs[i] = row;
    used.add(row.id);
  }
  return heirs;
}

function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = w * h;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

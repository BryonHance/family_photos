import { DatabaseSync } from "node:sqlite";
import type { Box, Face, PersonSummary } from "../../shared/analysis.ts";
import { petStore } from "../pets/store.ts";
import { regionStore } from "../recognition/regions.ts";
import { STRANGER_THRESHOLD, SUGGESTION_THRESHOLD } from "./thresholds.ts";

/**
 * faces.db holds face data (ADR-0002) and pet data (ADR-0003, in
 * ../pets/store.ts) and nothing else: per Face, its box, the Photo's SHA-256,
 * the model version, its embedding and its Person or "Not a face" mark; and
 * each Person's name. Never the Photo, its name, or any image of a Face. Kept in
 * its own file so it can be wiped in one step and kept out of off-server backups.
 *
 * How Faces are named, suggested and placed in Strangers is shared with
 * Animals, in ../recognition/regions.ts.
 */
const FACES = `(
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
    stranger_id   INTEGER REFERENCES strangers (id) ON DELETE SET NULL,
    CHECK (not_a_face = 0 OR (embedding IS NULL AND person_id IS NULL AND model_version IS NULL AND stranger_id IS NULL)),
    CHECK (not_a_face = 1 OR (embedding IS NOT NULL AND model_version IS NOT NULL)),
    CHECK (person_id IS NULL OR stranger_id IS NULL)
  )`;

const TABLES = `
  CREATE TABLE IF NOT EXISTS people (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS strangers (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  );
  CREATE TABLE IF NOT EXISTS faces ${FACES};
  CREATE TABLE IF NOT EXISTS rejected_suggestions (
    face_id   TEXT NOT NULL REFERENCES faces (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    PRIMARY KEY (face_id, person_id)
  );
  CREATE TABLE IF NOT EXISTS named_strangers (
    stranger_id INTEGER NOT NULL REFERENCES strangers (id) ON DELETE CASCADE,
    person_id   TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    PRIMARY KEY (stranger_id, person_id)
  );
  CREATE TABLE IF NOT EXISTS photos (
    sha256        TEXT PRIMARY KEY,
    model_version TEXT NOT NULL
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS faces_by_photo ON faces (photo_sha256);
  CREATE INDEX IF NOT EXISTS faces_by_person ON faces (person_id);
  CREATE INDEX IF NOT EXISTS faces_by_stranger ON faces (stranger_id);
`;

/** A Face as the detector found it, before it is stored. */
export type NewFace = { box: Box; embedding: Float32Array };

export type FaceStore = ReturnType<typeof openFaceStore>;

/** Opens (or creates) faces.db at `path`; `":memory:"` keeps it in memory. */
export function openFaceStore(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");

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

  const faces = regionStore<NewFace, Face>(db, transaction, {
    tables: {
      regions: "faces",
      notA: "not_a_face",
      knowns: "people",
      knownId: "person_id",
      unknowns: "strangers",
      unknownId: "stranger_id",
      rejections: "rejected_suggestions",
      rejectionRegionId: "face_id",
      namedUnknowns: "named_strangers",
      photos: "photos",
      extraColumns: [],
    },
    definition: FACES,
    createTables: TABLES,
    createIndexes: INDEXES,
    suggestionThreshold: SUGGESTION_THRESHOLD,
    unknownThreshold: STRANGER_THRESHOLD,
    extraValues: () => [],
    show: ({ id, box, known, suggestion, unknown }) => ({
      id,
      box,
      ...(known && { person: known }),
      ...(suggestion && { suggestion }),
      ...(unknown && { stranger: { label: `Unknown ${unknown.id}`, photoCount: unknown.photoCount } }),
    }),
  });
  // faces.db files made before the photos table: each Photo was read by the version its Faces carry.
  db.exec(`
    INSERT OR IGNORE INTO photos (sha256, model_version)
    SELECT photo_sha256, MAX(model_version) FROM faces WHERE model_version IS NOT NULL GROUP BY photo_sha256`);

  const pets = petStore(db, transaction);

  return {
    /** The pet half of the store: Animals and Pets, apart from Faces and People. */
    pets,

    /** The Faces of a Photo, left to right, without those marked "Not a face". */
    facesOfPhoto: faces.regionsOfPhoto,
    /** "no-region" when there is no such Face, or it is marked "Not a face". */
    facesOfPhotoOf: faces.regionsOfPhotoOf,
    nameFace: faces.name,
    confirmSuggestion: faces.confirmSuggestion,
    rejectSuggestion: faces.rejectSuggestion,
    markNotAFace: faces.markNotA,
    people: (): PersonSummary[] => faces.knowns().map(({ regionCount, ...person }) => ({ ...person, faceCount: regionCount })),
    renamePerson: faces.rename,
    mergePeople: faces.merge,
    deletePerson: faces.delete,

    /**
     * Deletes every Face, Person, Animal and Pet, then rewrites the file so that
     * no deleted embedding lingers in its free pages or its write-ahead log.
     */
    deleteAllFaceAndPetData() {
      transaction(() => {
        pets.deleteAllRows();
        faces.deleteAllRows();
      });
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },

    close: () => db.close(),
  };
}

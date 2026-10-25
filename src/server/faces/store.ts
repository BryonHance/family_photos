import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Box, Face, PersonRef, PersonSummary } from "../../shared/analysis.ts";
import { STRANGER_THRESHOLD, SUGGESTION_THRESHOLD } from "./thresholds.ts";

/**
 * faces.db holds face data and nothing else (ADR-0002): per Face, its box, the
 * Photo's SHA-256, the model version, its embedding and its Person or "Not a
 * face" mark; and each Person's name. Never the Photo, its name, or any image
 * of a Face. Kept in its own file so it can be wiped in one step and kept out
 * of off-server backups.
 *
 * A Face marked "Not a face" keeps only its box and the Photo's hash: its
 * embedding, Person and model version are cleared.
 *
 * Each rejected Suggestion is kept as the pair of Face and Person, so that it
 * is never suggested again. A Stranger is only a number: its Faces point to it.
 * AUTOINCREMENT keeps a number from ever being reused once its Stranger empties.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS people (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS strangers (
    id INTEGER PRIMARY KEY AUTOINCREMENT
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
    stranger_id   INTEGER REFERENCES strangers (id) ON DELETE SET NULL,
    CHECK (not_a_face = 0 OR (embedding IS NULL AND person_id IS NULL AND model_version IS NULL AND stranger_id IS NULL)),
    CHECK (not_a_face = 1 OR (embedding IS NOT NULL AND model_version IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS faces_by_photo ON faces (photo_sha256);
  CREATE INDEX IF NOT EXISTS faces_by_person ON faces (person_id);
  CREATE TABLE IF NOT EXISTS rejected_suggestions (
    face_id   TEXT NOT NULL REFERENCES faces (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    PRIMARY KEY (face_id, person_id)
  );
`;

/** A Face as the store returns it: what the Analysis shows. */
export type StoredFace = Face;

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
  stranger_id: number | null;
  /** How many Photos the unnamed Faces of its Stranger span. */
  stranger_photos: number;
};

type EmbeddingRow = {
  id: string;
  embedding: Uint8Array;
  model_version: string | null;
  person_id: string | null;
  stranger_id: number | null;
};
type NamedRow = {
  photo_sha256: string;
  embedding: Uint8Array;
  person_id: string;
  stranger_id: number | null;
  person_name: string;
};

/** Opens (or creates) faces.db at `path`; `":memory:"` keeps it in memory. */
export function openFaceStore(path: string) {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  // faces.db files made before Strangers lack the column (and so its CHECK).
  const columns = db.prepare("PRAGMA table_info(faces)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "stranger_id")) {
    db.exec("ALTER TABLE faces ADD COLUMN stranger_id INTEGER REFERENCES strangers (id) ON DELETE SET NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS faces_by_stranger ON faces (stranger_id)");

  const facesOfPhotoQuery = db.prepare(`
    SELECT faces.id, box_x, box_y, box_width, box_height, model_version, person_id, not_a_face, stranger_id,
           people.name AS person_name,
           (SELECT COUNT(DISTINCT member.photo_sha256) FROM faces AS member
            WHERE member.stranger_id = faces.stranger_id AND member.person_id IS NULL) AS stranger_photos
    FROM faces LEFT JOIN people ON people.id = faces.person_id
    WHERE photo_sha256 = ?
    ORDER BY box_x`);
  const insertFace = db.prepare(`
    INSERT INTO faces (id, photo_sha256, box_x, box_y, box_width, box_height, model_version, embedding, person_id, not_a_face)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteFacesOfPhoto = db.prepare("DELETE FROM faces WHERE photo_sha256 = ?");
  const findFace = db.prepare("SELECT not_a_face FROM faces WHERE id = ?");
  const setPersonOfFace = db.prepare("UPDATE faces SET person_id = ? WHERE id = ?");
  const markNotAFace = db.prepare(
    "UPDATE faces SET not_a_face = 1, embedding = NULL, person_id = NULL, model_version = NULL, stranger_id = NULL WHERE id = ?",
  );
  const findPersonByName = db.prepare("SELECT id, name FROM people WHERE name = ?");
  const insertPerson = db.prepare("INSERT INTO people (id, name) VALUES (?, ?)");
  const findPerson = db.prepare("SELECT id FROM people WHERE id = ?");
  const renamePerson = db.prepare("UPDATE people SET name = ? WHERE id = ?");
  const movePersonFaces = db.prepare("UPDATE faces SET person_id = ? WHERE person_id = ?");
  // Their Faces are left unnamed by ON DELETE SET NULL.
  const deletePerson = db.prepare("DELETE FROM people WHERE id = ?");
  const listPeople = db.prepare(`
    SELECT people.id, people.name, COUNT(faces.id) AS faceCount
    FROM people LEFT JOIN faces ON faces.person_id = people.id
    GROUP BY people.id
    ORDER BY people.name`);

  // Every named Face's embedding, for Suggestions: a plain scan, no vector index (spec #12).
  const namedFaces = db.prepare(`
    SELECT photo_sha256, embedding, person_id, stranger_id, people.name AS person_name
    FROM faces JOIN people ON people.id = faces.person_id
    WHERE model_version = ?`);
  const embeddingsOfPhoto = db.prepare(
    "SELECT id, embedding, model_version, person_id, stranger_id FROM faces WHERE photo_sha256 = ? AND embedding IS NOT NULL",
  );
  // The unnamed Faces of every Stranger, for Faces looking for one to join.
  const strangerMembers = db.prepare(`
    SELECT photo_sha256, embedding, stranger_id FROM faces
    WHERE stranger_id IS NOT NULL AND person_id IS NULL AND model_version = ?`);
  // For each Face of a Photo, the Strangers it must not join: those with a Face
  // named as a Person it rejected.
  const barredStrangers = db.prepare(`
    SELECT rejected_suggestions.face_id, named.stranger_id
    FROM rejected_suggestions
    JOIN faces AS face ON face.id = rejected_suggestions.face_id
    JOIN faces AS named ON named.person_id = rejected_suggestions.person_id
    WHERE face.photo_sha256 = ? AND named.stranger_id IS NOT NULL`);
  const photosOfPerson = db.prepare("SELECT DISTINCT photo_sha256 FROM faces WHERE person_id = ?");
  const leaveStrangers = db.prepare("UPDATE faces SET stranger_id = NULL WHERE person_id = ?");
  const leaveStrangerOfPerson = db.prepare(`
    UPDATE faces SET stranger_id = NULL
    WHERE id = ?1 AND stranger_id IN (SELECT stranger_id FROM faces WHERE person_id = ?2)`);
  const newStranger = db.prepare("INSERT INTO strangers DEFAULT VALUES");
  const setStrangerOfFace = db.prepare("UPDATE faces SET stranger_id = ? WHERE id = ?");
  const deleteEmptyStrangers = db.prepare(
    "DELETE FROM strangers WHERE id NOT IN (SELECT stranger_id FROM faces WHERE stranger_id IS NOT NULL)",
  );
  const rejectionsOfPhoto = db.prepare(`
    SELECT face_id, rejected_suggestions.person_id
    FROM rejected_suggestions JOIN faces ON faces.id = rejected_suggestions.face_id
    WHERE photo_sha256 = ?`);
  const rejectSuggestion = db.prepare("INSERT OR IGNORE INTO rejected_suggestions (face_id, person_id) VALUES (?, ?)");
  const photoOfFace = db.prepare("SELECT photo_sha256 FROM faces WHERE id = ? AND not_a_face = 0");
  const findPersonById = db.prepare("SELECT id, name FROM people WHERE id = ?");

  const rowsOf = (sha256: string) => facesOfPhotoQuery.all(sha256) as FaceRow[];
  // Faces marked "Not a face" carry no model version, so they never make a Photo stale.
  const isCurrent = (rows: FaceRow[], modelVersion: string) =>
    rows.length > 0 && rows.every((r) => r.model_version === null || r.model_version === modelVersion);

  /**
   * The Faces of a stored Photo as the Analysis shows them, after placing each
   * unnamed Face that has no Suggestion and no Stranger in one. Call it inside a transaction.
   */
  function present(sha256: string): StoredFace[] {
    let suggestions = suggestionsFor(sha256);
    if (joinStrangers(sha256, suggestions)) suggestions = suggestionsFor(sha256);
    return visible(rowsOf(sha256), suggestions);
  }

  /**
   * Places each unnamed Face of a Photo that has no Suggestion and no Stranger:
   * it joins the Stranger of its most similar unnamed Face in another Photo, at
   * or above STRANGER_THRESHOLD, or starts a new one. Each Face chooses on its
   * own, so two Faces of one Photo may join the same Stranger. A Face never
   * joins a Stranger with a Face named as a Person it rejected. Strangers never
   * merge. True when any Face was placed.
   */
  function joinStrangers(sha256: string, suggestions: Map<string, PersonRef>): boolean {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const waiting = own.filter((f) => f.person_id === null && f.stranger_id === null && !suggestions.has(f.id));
    const modelVersion = waiting[0]?.model_version;
    if (modelVersion == null) return false;
    const barred = new Set(
      (barredStrangers.all(sha256) as { face_id: string; stranger_id: number }[]).map((r) => `${r.face_id} ${r.stranger_id}`),
    );
    const members = (strangerMembers.all(modelVersion) as { photo_sha256: string; embedding: Uint8Array; stranger_id: number }[])
      .filter((m) => m.photo_sha256 !== sha256)
      .map((m) => ({ strangerId: m.stranger_id, embedding: embeddingOf(m.embedding) }));

    for (const face of waiting) {
      const embedding = embeddingOf(face.embedding);
      let nearest: { strangerId: number; score: number } | undefined;
      for (const member of members) {
        if (barred.has(`${face.id} ${member.strangerId}`)) continue;
        const score = cosine(embedding, member.embedding);
        if (score >= STRANGER_THRESHOLD && score > (nearest?.score ?? -Infinity)) nearest = { strangerId: member.strangerId, score };
      }
      setStrangerOfFace.run(nearest?.strangerId ?? newStranger.run().lastInsertRowid, face.id);
    }
    return true;
  }

  /**
   * Each unnamed Face's Suggestion: the Person of its nearest named Face in
   * another Photo, at or above SUGGESTION_THRESHOLD, or the Person of a named
   * Face of its Stranger however alike they are; unless the user rejected that
   * Person for it. A Person already named in this Photo is not
   * suggested, and no two Faces of one Photo are suggested as the same Person:
   * the better match wins, and the other Face gets no Suggestion at all (it then
   * follows the Stranger rule), never its next-best Person.
   */
  function suggestionsFor(sha256: string): Map<string, PersonRef> {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const modelVersion = own[0]?.model_version;
    const unnamed = own.filter((face) => face.person_id === null);
    const suggestions = new Map<string, PersonRef>();
    if (modelVersion == null || unnamed.length === 0) return suggestions;
    const namedHere = new Set(own.map((face) => face.person_id));
    const named = (namedFaces.all(modelVersion) as NamedRow[])
      .filter((row) => row.photo_sha256 !== sha256 && !namedHere.has(row.person_id))
      .map((row) => ({
        person: { id: row.person_id, name: row.person_name },
        strangerId: row.stranger_id,
        embedding: embeddingOf(row.embedding),
      }));

    const rejected = new Set(
      (rejectionsOfPhoto.all(sha256) as { face_id: string; person_id: string }[]).map((r) => `${r.face_id} ${r.person_id}`),
    );

    // Each Face's own best Person first; only then are clashes settled.
    const pairs: { faceId: string; person: PersonRef; score: number }[] = [];
    for (const face of unnamed) {
      const embedding = embeddingOf(face.embedding);
      const best = new Map<string, { person: PersonRef; score: number; sameStranger: boolean }>();
      for (const candidate of named) {
        if (rejected.has(`${face.id} ${candidate.person.id}`)) continue;
        const score = cosine(embedding, candidate.embedding);
        const sameStranger = face.stranger_id !== null && candidate.strangerId === face.stranger_id;
        const known = best.get(candidate.person.id);
        best.set(candidate.person.id, {
          person: candidate.person,
          score: Math.max(score, known?.score ?? -Infinity),
          sameStranger: sameStranger || (known?.sameStranger ?? false),
        });
      }
      const qualifying = [...best.values()].filter((b) => b.sameStranger || b.score >= SUGGESTION_THRESHOLD);
      const nearest = qualifying.sort((a, b) => b.score - a.score)[0];
      if (nearest) pairs.push({ faceId: face.id, person: nearest.person, score: nearest.score });
    }
    // Two Faces wanting the same Person: the better match wins, and the other gets no Suggestion.
    const suggested = new Set<string>();
    for (const { faceId, person } of pairs.sort((a, b) => b.score - a.score)) {
      if (suggested.has(person.id)) continue;
      suggestions.set(faceId, person);
      suggested.add(person.id);
    }
    return suggestions;
  }

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
      if (isCurrent(stored, photo.modelVersion)) return transaction(() => present(photo.sha256));
      const detected = await detect();
      return transaction(() => {
        const old = rowsOf(photo.sha256);
        // Another request for the same Photo may have stored it while this one was detecting.
        if (isCurrent(old, photo.modelVersion)) return present(photo.sha256);
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
        deleteEmptyStrangers.run();
        return present(photo.sha256);
      });
    },

    /**
     * Names a Face: the Person with this name, ignoring case and spaces around
     * it, or a new Person. Undefined when there is no such Face, or it is marked "Not a face".
     */
    nameFace(faceId: string, name: string): PersonRef | undefined {
      return transaction(() => {
        const face = findFace.get(faceId) as { not_a_face: number } | undefined;
        if (!face || face.not_a_face === 1) return undefined;
        const person = personNamed(name);
        setPersonOfFace.run(person.id, faceId);
        return person;
      });
    },

    /** Names a Face as the Person it was suggested as. */
    confirmSuggestion(faceId: string, personId: string): PersonRef | "no-face" | "no-person" {
      return transaction(() => {
        if (!photoOfFace.get(faceId)) return "no-face";
        const person = findPersonById.get(personId) as PersonRef | undefined;
        if (!person) return "no-person";
        setPersonOfFace.run(person.id, faceId);
        return { id: person.id, name: person.name };
      });
    },

    /**
     * Remembers that a Face is not this Person, so they are never suggested for
     * it again. Returns the Face as it now stands.
     */
    rejectSuggestion(faceId: string, personId: string): StoredFace | "no-face" | "no-person" {
      return transaction(() => {
        const photo = photoOfFace.get(faceId) as { photo_sha256: string } | undefined;
        if (!photo) return "no-face";
        if (!findPersonById.get(personId)) return "no-person";
        rejectSuggestion.run(faceId, personId);
        // Out of a Stranger that has a Face named as this Person; it then joins another by the usual rule.
        if (leaveStrangerOfPerson.run(faceId, personId).changes > 0) deleteEmptyStrangers.run();
        return present(photo.photo_sha256).find((face) => face.id === faceId)!;
      });
    },

    /**
     * Marks a Face "Not a face": it keeps only its box and the Photo's hash, and
     * stays hidden whenever the Photo is reopened. False when there is no such Face.
     */
    markNotAFace(faceId: string): boolean {
      return transaction(() => {
        const marked = markNotAFace.run(faceId).changes > 0;
        deleteEmptyStrangers.run();
        return marked;
      });
    },

    /** Every Person, by name, with how many Faces are named as them. */
    people: () => listPeople.all() as PersonSummary[],

    /** "taken" when another Person already has the name, ignoring case. */
    renamePerson(personId: string, name: string): PersonRef | "not-found" | "taken" {
      return transaction(() => {
        if (!findPerson.get(personId)) return "not-found";
        const holder = findPersonByName.get(name) as PersonRef | undefined;
        if (holder && holder.id !== personId) return "taken";
        renamePerson.run(name, personId);
        return { id: personId, name };
      });
    },

    /** Names every Face of `personId` as `intoPersonId` instead, then deletes `personId`. */
    mergePeople(personId: string, intoPersonId: string): "merged" | "not-found" | "same" {
      if (personId === intoPersonId) return "same";
      return transaction(() => {
        if (!findPerson.get(personId) || !findPerson.get(intoPersonId)) return "not-found";
        movePersonFaces.run(intoPersonId, personId);
        deletePerson.run(personId);
        return "merged";
      });
    },

    /**
     * Deletes a Person; their Faces stay stored, unnamed, and join Strangers
     * again by the usual rule. False when there is no such Person.
     */
    deletePerson(personId: string): boolean {
      return transaction(() => {
        const photos = photosOfPerson.all(personId) as { photo_sha256: string }[];
        leaveStrangers.run(personId);
        if (deletePerson.run(personId).changes === 0) return false;
        deleteEmptyStrangers.run();
        for (const { photo_sha256 } of photos) present(photo_sha256);
        return true;
      });
    },

    /**
     * Deletes every Face and Person, then rewrites the file so that no deleted
     * embedding lingers in its free pages or its write-ahead log.
     */
    deleteAllFaceData() {
      transaction(() => {
        db.exec("DELETE FROM faces");
        db.exec("DELETE FROM people");
        db.exec("DELETE FROM strangers");
        // Nothing is left to confuse a new Stranger with, so numbering starts again.
        db.exec("DELETE FROM sqlite_sequence WHERE name = 'strangers'");
      });
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },

    close: () => db.close(),
  };

  function personNamed(name: string): PersonRef {
    const existing = findPersonByName.get(name) as PersonRef | undefined;
    if (existing) return existing;
    const person = { id: randomUUID(), name };
    insertPerson.run(person.id, person.name);
    return person;
  }
}

/** A Stranger's label shows once its unnamed Faces span this many Photos. */
const STRANGER_LABEL_PHOTOS = 2;

/** Each Face shows at most one of its Person, its Suggestion, or its Stranger's label. */
function visible(rows: FaceRow[], suggestions: Map<string, PersonRef>): StoredFace[] {
  return rows
    .filter((r) => r.not_a_face === 0)
    .map((r) => {
      const face: StoredFace = { id: r.id, box: boxOf(r) };
      const suggestion = suggestions.get(r.id);
      if (r.person_id !== null && r.person_name !== null) face.person = { id: r.person_id, name: r.person_name };
      else if (suggestion) face.suggestion = suggestion;
      else if (r.stranger_id !== null && r.stranger_photos >= STRANGER_LABEL_PHOTOS) {
        face.stranger = { label: `Unknown ${r.stranger_id}`, photoCount: r.stranger_photos };
      }
      return face;
    });
}

/** The embedding a BLOB holds: 512 float32s, copied so that its alignment does not matter. */
const embeddingOf = (blob: Uint8Array) => new Float32Array(new Uint8Array(blob).buffer);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // Both are L2-normalised.
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

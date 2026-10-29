import type { DatabaseSync } from "node:sqlite";
import type { Animal, Box, PetSummary, Species } from "../../shared/analysis.ts";
import { regionStore } from "../recognition/regions.ts";
import { SUGGESTION_THRESHOLD, UNKNOWN_PET_THRESHOLD } from "./thresholds.ts";

/**
 * Pet data, kept in faces.db beside face data so that the same delete wipes it
 * and the same backup rule keeps it on the server (ADR-0003): per Animal, its
 * box, species, the Photo's SHA-256, the pet model version, its embedding and
 * its Pet, Unknown pet, rejected Suggestions or "Not a pet" mark; and each
 * Pet's name. Pets are not People: they have their own table and their own
 * names. Never the Photo, its name, or any image of an Animal.
 *
 * An Animal marked "Not a pet" also loses its species. How Animals are named,
 * suggested and placed in Unknown pets is shared with Faces, in
 * ../recognition/regions.ts.
 */
const ANIMALS = `(
    id             TEXT PRIMARY KEY,
    photo_sha256   TEXT NOT NULL,
    box_x          REAL NOT NULL,
    box_y          REAL NOT NULL,
    box_width      REAL NOT NULL,
    box_height     REAL NOT NULL,
    species        TEXT CHECK (species IN ('cat', 'dog')),
    model_version  TEXT,
    embedding      BLOB,
    pet_id         TEXT REFERENCES pets (id) ON DELETE SET NULL,
    not_a_pet      INTEGER NOT NULL DEFAULT 0 CHECK (not_a_pet IN (0, 1)),
    unknown_pet_id INTEGER REFERENCES unknown_pets (id) ON DELETE SET NULL,
    CHECK (not_a_pet = 0 OR (species IS NULL AND embedding IS NULL AND pet_id IS NULL AND model_version IS NULL AND unknown_pet_id IS NULL)),
    CHECK (not_a_pet = 1 OR (species IS NOT NULL AND embedding IS NOT NULL AND model_version IS NOT NULL)),
    CHECK (pet_id IS NULL OR unknown_pet_id IS NULL)
  )`;

const TABLES = `
  CREATE TABLE IF NOT EXISTS pets (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS unknown_pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  );
  CREATE TABLE IF NOT EXISTS animals ${ANIMALS};
  CREATE TABLE IF NOT EXISTS rejected_pet_suggestions (
    animal_id TEXT NOT NULL REFERENCES animals (id) ON DELETE CASCADE,
    pet_id    TEXT NOT NULL REFERENCES pets (id) ON DELETE CASCADE,
    PRIMARY KEY (animal_id, pet_id)
  );
  CREATE TABLE IF NOT EXISTS named_unknown_pets (
    unknown_pet_id INTEGER NOT NULL REFERENCES unknown_pets (id) ON DELETE CASCADE,
    pet_id         TEXT NOT NULL REFERENCES pets (id) ON DELETE CASCADE,
    PRIMARY KEY (unknown_pet_id, pet_id)
  );
  CREATE TABLE IF NOT EXISTS animal_photos (
    sha256        TEXT PRIMARY KEY,
    model_version TEXT NOT NULL
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS animals_by_photo ON animals (photo_sha256);
  CREATE INDEX IF NOT EXISTS animals_by_pet ON animals (pet_id);
  CREATE INDEX IF NOT EXISTS animals_by_unknown_pet ON animals (unknown_pet_id);
`;

/** An Animal as the pet models found it, before it is stored. */
export type NewAnimal = { species: Species; box: Box; embedding: Float32Array };

export type PetStore = ReturnType<typeof petStore>;

/**
 * The pet half of faces.db, on its open database. `transaction` is the face
 * store's, so that both halves take turns the same way.
 */
export function petStore(db: DatabaseSync, transaction: <T>(work: () => T) => T) {
  const animals = regionStore<NewAnimal, Animal>(db, transaction, {
    tables: {
      regions: "animals",
      notA: "not_a_pet",
      knowns: "pets",
      knownId: "pet_id",
      unknowns: "unknown_pets",
      unknownId: "unknown_pet_id",
      rejections: "rejected_pet_suggestions",
      rejectionRegionId: "animal_id",
      namedUnknowns: "named_unknown_pets",
      photos: "animal_photos",
      extraColumns: ["species"],
    },
    definition: ANIMALS,
    createTables: TABLES,
    createIndexes: INDEXES,
    suggestionThreshold: SUGGESTION_THRESHOLD,
    unknownThreshold: UNKNOWN_PET_THRESHOLD,
    extraValues: (animal) => [animal.species],
    show: ({ id, box, extra, known, suggestion, unknown }) => ({
      id,
      species: extra.species as Species,
      box,
      ...(known && { pet: known }),
      ...(suggestion && { suggestion }),
      ...(unknown && { unknownPet: { label: `Unknown pet ${unknown.id}`, photoCount: unknown.photoCount } }),
    }),
  });

  return {
    /** The Animals of a Photo, left to right, without those marked "Not a pet". */
    animalsOfPhoto: animals.regionsOfPhoto,
    /** "no-region" when there is no such Animal, or it is marked "Not a pet". */
    animalsOfPhotoOf: animals.regionsOfPhotoOf,
    /** Only Pets are looked at, never People. */
    nameAnimal: animals.name,
    confirmSuggestion: animals.confirmSuggestion,
    rejectSuggestion: animals.rejectSuggestion,
    markNotAPet: animals.markNotA,
    pets: (): PetSummary[] => animals.knowns().map(({ regionCount, ...pet }) => ({ ...pet, animalCount: regionCount })),
    /** People's names are not looked at. */
    renamePet: animals.rename,
    /** Only Pets are looked at, so a Pet never merges into a Person. */
    mergePets: animals.merge,
    deletePet: animals.delete,
    /** Deletes every Animal, Pet and Unknown pet. Call it inside the face store's transaction. */
    deleteAllRows: animals.deleteAllRows,
  };
}

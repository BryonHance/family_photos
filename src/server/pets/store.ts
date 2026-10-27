import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Animal, Box, PetRef, PetSummary, Species } from "../../shared/analysis.ts";
import type { PhotoKey } from "../recognition/photo-key.ts";
import { heirsOf } from "../recognition/overlap.ts";
import { upgradeTable } from "../recognition/schema.ts";
import { cosine, embeddingOf, pairSet } from "../recognition/similarity.ts";
import { SUGGESTION_THRESHOLD, UNKNOWN_PET_THRESHOLD } from "./thresholds.ts";

/**
 * Pet data, kept in faces.db beside face data so that the same delete wipes it
 * and the same backup rule keeps it on the server (ADR-0003): per Animal, its
 * box, species, the Photo's SHA-256, the pet model version, its embedding and
 * its Pet, Unknown pet, rejected Suggestions or "Not a pet" mark; and each
 * Pet's name. Pets are not People: they have their own table and their own
 * names. Never the Photo, its name, or any image of an Animal.
 *
 * An Animal marked "Not a pet" keeps only its box and the Photo's hash: its
 * species, embedding, Pet, Unknown pet, model version and rejected Suggestions
 * are cleared.
 *
 * An Animal has exactly one state (spec #20): named as a Pet, in an Unknown
 * pet (its Suggestion, if any, is worked out afresh each time the Photo is
 * opened), or marked "Not a pet". The table's CHECKs refuse any other mix.
 *
 * Each rejected Suggestion is kept as the pair of Animal and Pet, so that it is
 * never suggested again. An Unknown pet is only a number: its Animals point to
 * it. AUTOINCREMENT keeps a number from ever being reused once its Unknown pet
 * empties, and through "Delete all face and pet data", as for Strangers. Naming
 * one of its Animals takes that Animal out, and keeps the pair of Unknown pet
 * and Pet so that the rest are suggested as that Pet.
 *
 * Each Photo with stored Animals keeps the pet model version that last read it,
 * apart from the face model version, so that a change to either model detects
 * only its own kind again.
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
 * A detected Animal whose box overlaps an old one by at least this IoU inherits
 * its Pet or "Not a pet" mark, and its rejected Suggestions.
 */
const INHERIT_IOU = 0.5;

type EmbeddingRow = {
  id: string;
  embedding: Uint8Array;
  model_version: string | null;
  pet_id: string | null;
  unknown_pet_id: number | null;
};
type NamedRow = {
  photo_sha256: string;
  embedding: Uint8Array;
  pet_id: string;
  pet_name: string;
};

type AnimalRow = {
  id: string;
  box_x: number;
  box_y: number;
  box_width: number;
  box_height: number;
  species: Species | null;
  pet_id: string | null;
  pet_name: string | null;
  not_a_pet: number;
  unknown_pet_id: number | null;
  /** How many Photos the unnamed Animals of its Unknown pet span. */
  unknown_pet_photos: number;
};

/**
 * The pet half of faces.db, on its open database. `transaction` is the face
 * store's, so that both halves take turns the same way.
 */
export function petStore(db: DatabaseSync, transaction: <T>(work: () => T) => T) {
  db.exec(TABLES);
  // faces.db files made before Unknown pets lack the column.
  const columns = db.prepare("PRAGMA table_info(animals)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "unknown_pet_id")) {
    db.exec("ALTER TABLE animals ADD COLUMN unknown_pet_id INTEGER REFERENCES unknown_pets (id) ON DELETE SET NULL");
  }
  // faces.db files made before an Animal had one state kept a named Animal in its
  // Unknown pet: it leaves, and the Unknown pet remembers it was named so.
  upgradeTable(
    db,
    "animals",
    ANIMALS,
    `INSERT OR IGNORE INTO named_unknown_pets (unknown_pet_id, pet_id)
       SELECT unknown_pet_id, pet_id FROM animals WHERE pet_id IS NOT NULL AND unknown_pet_id IS NOT NULL;
     UPDATE animals SET unknown_pet_id = NULL WHERE pet_id IS NOT NULL;`,
  );
  db.exec(INDEXES);

  const animalsOfPhotoQuery = db.prepare(`
    SELECT animals.id, box_x, box_y, box_width, box_height, species, pet_id, not_a_pet, unknown_pet_id,
           pets.name AS pet_name,
           (SELECT COUNT(DISTINCT member.photo_sha256) FROM animals AS member
            WHERE member.unknown_pet_id = animals.unknown_pet_id) AS unknown_pet_photos
    FROM animals LEFT JOIN pets ON pets.id = animals.pet_id
    WHERE photo_sha256 = ?
    ORDER BY box_x`);
  const insertAnimal = db.prepare(`
    INSERT INTO animals (id, photo_sha256, box_x, box_y, box_width, box_height, species, model_version, embedding, pet_id, not_a_pet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteAnimalsOfPhoto = db.prepare("DELETE FROM animals WHERE photo_sha256 = ?");
  const findAnimal = db.prepare("SELECT not_a_pet FROM animals WHERE id = ?");
  // Naming an Animal takes it out of its Unknown pet, which remembers the Pet for the rest.
  const nameUnknownPet = db.prepare(`
    INSERT OR IGNORE INTO named_unknown_pets (unknown_pet_id, pet_id)
    SELECT unknown_pet_id, ?2 FROM animals WHERE id = ?1 AND unknown_pet_id IS NOT NULL`);
  const setPetOfAnimal = db.prepare("UPDATE animals SET pet_id = ?, unknown_pet_id = NULL WHERE id = ?");
  const markNotAPet = db.prepare(
    `UPDATE animals SET not_a_pet = 1, species = NULL, embedding = NULL, pet_id = NULL, model_version = NULL, unknown_pet_id = NULL
     WHERE id = ?`,
  );
  const findPetByName = db.prepare("SELECT id, name FROM pets WHERE name = ?");
  const insertPet = db.prepare("INSERT INTO pets (id, name) VALUES (?, ?)");
  const findPet = db.prepare("SELECT id, name FROM pets WHERE id = ?");
  const renamePet = db.prepare("UPDATE pets SET name = ? WHERE id = ?");
  const movePetAnimals = db.prepare("UPDATE animals SET pet_id = ? WHERE pet_id = ?");
  // Those left behind go with the merged Pet, by ON DELETE CASCADE.
  const movePetUnknownPets = db.prepare("UPDATE OR IGNORE named_unknown_pets SET pet_id = ? WHERE pet_id = ?");
  // Its Animals are left unnamed by ON DELETE SET NULL, and its Unknown pets no longer named so by ON DELETE CASCADE.
  const deletePet = db.prepare("DELETE FROM pets WHERE id = ?");
  const listPets = db.prepare(`
    SELECT pets.id, pets.name, COUNT(animals.id) AS animalCount
    FROM pets LEFT JOIN animals ON animals.pet_id = pets.id
    GROUP BY pets.id
    ORDER BY pets.name`);
  // Every named Animal's embedding, for Suggestions: a plain scan, never mixed with Faces (spec #20).
  const namedAnimals = db.prepare(`
    SELECT photo_sha256, embedding, pet_id, pets.name AS pet_name
    FROM animals JOIN pets ON pets.id = animals.pet_id
    WHERE model_version = ?`);
  const embeddingsOfPhoto = db.prepare(
    "SELECT id, embedding, model_version, pet_id, unknown_pet_id FROM animals WHERE photo_sha256 = ? AND embedding IS NOT NULL",
  );
  // The unnamed Animals of every Unknown pet, for Animals looking for one to join.
  const unknownPetMembers = db.prepare(`
    SELECT photo_sha256, embedding, unknown_pet_id FROM animals
    WHERE unknown_pet_id IS NOT NULL AND model_version = ?`);
  // The Pets each Unknown pet of a Photo's Animals was named as, through one of its Animals.
  const namesOfUnknownPets = db.prepare(`
    SELECT DISTINCT named_unknown_pets.unknown_pet_id, named_unknown_pets.pet_id
    FROM named_unknown_pets JOIN animals ON animals.unknown_pet_id = named_unknown_pets.unknown_pet_id
    WHERE animals.photo_sha256 = ?`);
  // For each Animal of a Photo, the Unknown pets it must not join: those named
  // as a Pet it rejected.
  const barredUnknownPets = db.prepare(`
    SELECT rejected_pet_suggestions.animal_id, named_unknown_pets.unknown_pet_id
    FROM rejected_pet_suggestions
    JOIN animals ON animals.id = rejected_pet_suggestions.animal_id
    JOIN named_unknown_pets ON named_unknown_pets.pet_id = rejected_pet_suggestions.pet_id
    WHERE animals.photo_sha256 = ?`);
  const photosOfPet = db.prepare("SELECT DISTINCT photo_sha256 FROM animals WHERE pet_id = ?");
  const leaveUnknownPetOfPet = db.prepare(`
    UPDATE animals SET unknown_pet_id = NULL
    WHERE id = ?1 AND unknown_pet_id IN (SELECT unknown_pet_id FROM named_unknown_pets WHERE pet_id = ?2)`);
  const newUnknownPet = db.prepare("INSERT INTO unknown_pets DEFAULT VALUES");
  const setUnknownPetOfAnimal = db.prepare("UPDATE animals SET unknown_pet_id = ? WHERE id = ?");
  const deleteEmptyUnknownPets = db.prepare(
    "DELETE FROM unknown_pets WHERE id NOT IN (SELECT unknown_pet_id FROM animals WHERE unknown_pet_id IS NOT NULL)",
  );
  const rejectionsOfPhoto = db.prepare(`
    SELECT animal_id, rejected_pet_suggestions.pet_id
    FROM rejected_pet_suggestions JOIN animals ON animals.id = rejected_pet_suggestions.animal_id
    WHERE photo_sha256 = ?`);
  const rejectSuggestion = db.prepare("INSERT OR IGNORE INTO rejected_pet_suggestions (animal_id, pet_id) VALUES (?, ?)");
  const forgetRejections = db.prepare("DELETE FROM rejected_pet_suggestions WHERE animal_id = ?");
  const photoOfAnimal = db.prepare("SELECT photo_sha256 FROM animals WHERE id = ? AND not_a_pet = 0");

  const modelVersionOfPhoto = db.prepare("SELECT model_version FROM animal_photos WHERE sha256 = ?");
  const setModelVersionOfPhoto = db.prepare("INSERT OR REPLACE INTO animal_photos (sha256, model_version) VALUES (?, ?)");
  const forgetPhoto = db.prepare("DELETE FROM animal_photos WHERE sha256 = ?");

  const rowsOf = (sha256: string) => animalsOfPhotoQuery.all(sha256) as AnimalRow[];
  /** True when these pet models last read the Photo, and it has stored Animals. */
  const isCurrent = ({ sha256, modelVersion }: PhotoKey) =>
    (modelVersionOfPhoto.get(sha256) as { model_version: string } | undefined)?.model_version === modelVersion;

  /**
   * The Animals of a stored Photo as the Analysis shows them, after placing each
   * unnamed Animal that has no Suggestion and no Unknown pet in one. Call it inside a transaction.
   */
  function present(sha256: string): Animal[] {
    let suggestions = suggestionsFor(sha256);
    if (joinUnknownPets(sha256, suggestions)) suggestions = suggestionsFor(sha256);
    return visible(rowsOf(sha256), suggestions);
  }

  /**
   * Places each unnamed Animal of a Photo that has no Suggestion and no Unknown
   * pet: it joins the Unknown pet of its most similar unnamed Animal in another
   * Photo, at or above UNKNOWN_PET_THRESHOLD, or starts a new one. Each Animal
   * chooses on its own, so two Animals of one Photo may join the same Unknown
   * pet. An Animal never joins an Unknown pet named as a Pet it rejected. Unknown pets never merge. True when any Animal was placed.
   */
  function joinUnknownPets(sha256: string, suggestions: Map<string, PetRef>): boolean {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const waiting = own.filter((a) => a.pet_id === null && a.unknown_pet_id === null && !suggestions.has(a.id));
    const modelVersion = waiting[0]?.model_version;
    if (modelVersion == null) return false;
    const barred = pairSet(
      (barredUnknownPets.all(sha256) as { animal_id: string; unknown_pet_id: number }[]).map(
        (r) => [r.animal_id, r.unknown_pet_id] as const,
      ),
    );
    const members = (
      unknownPetMembers.all(modelVersion) as { photo_sha256: string; embedding: Uint8Array; unknown_pet_id: number }[]
    )
      .filter((m) => m.photo_sha256 !== sha256)
      .map((m) => ({ unknownPetId: m.unknown_pet_id, embedding: embeddingOf(m.embedding) }));

    for (const animal of waiting) {
      const embedding = embeddingOf(animal.embedding);
      let nearest: { unknownPetId: number; score: number } | undefined;
      for (const member of members) {
        if (barred.has(animal.id, member.unknownPetId)) continue;
        const score = cosine(embedding, member.embedding);
        if (score >= UNKNOWN_PET_THRESHOLD && score > (nearest?.score ?? -Infinity)) {
          nearest = { unknownPetId: member.unknownPetId, score };
        }
      }
      setUnknownPetOfAnimal.run(nearest?.unknownPetId ?? newUnknownPet.run().lastInsertRowid, animal.id);
    }
    return true;
  }

  /**
   * Each unnamed Animal's Suggestion: the Pet of its nearest named Animal in
   * another Photo, at or above SUGGESTION_THRESHOLD, or a Pet its Unknown pet
   * was named as however alike they are; unless the user rejected
   * that Pet for it. Species does not limit it: the detector's species is a hint,
   * not a fact about the Pet. A Pet already named in this Photo is not
   * suggested, and no two Animals of one Photo are suggested as the same Pet:
   * the better match wins, and the other Animal gets no Suggestion at all, never
   * its next-best Pet.
   */
  function suggestionsFor(sha256: string): Map<string, PetRef> {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const modelVersion = own[0]?.model_version;
    const unnamed = own.filter((animal) => animal.pet_id === null);
    const suggestions = new Map<string, PetRef>();
    if (modelVersion == null || unnamed.length === 0) return suggestions;
    const namedHere = new Set(own.map((animal) => animal.pet_id));
    const named = (namedAnimals.all(modelVersion) as NamedRow[])
      .filter((row) => row.photo_sha256 !== sha256 && !namedHere.has(row.pet_id))
      .map((row) => ({
        pet: { id: row.pet_id, name: row.pet_name },
        embedding: embeddingOf(row.embedding),
      }));
    const rejected = pairSet(
      (rejectionsOfPhoto.all(sha256) as { animal_id: string; pet_id: string }[]).map((r) => [r.animal_id, r.pet_id] as const),
    );
    const namedAs = pairSet(
      (namesOfUnknownPets.all(sha256) as { unknown_pet_id: number; pet_id: string }[]).map(
        (r) => [r.unknown_pet_id, r.pet_id] as const,
      ),
    );

    // Each Animal's own best Pet first; only then are clashes settled.
    const pairs: { animalId: string; pet: PetRef; score: number }[] = [];
    for (const animal of unnamed) {
      const embedding = embeddingOf(animal.embedding);
      const best = new Map<string, { pet: PetRef; score: number; sameUnknownPet: boolean }>();
      for (const candidate of named) {
        if (rejected.has(animal.id, candidate.pet.id)) continue;
        const score = cosine(embedding, candidate.embedding);
        const sameUnknownPet = animal.unknown_pet_id !== null && namedAs.has(animal.unknown_pet_id, candidate.pet.id);
        const known = best.get(candidate.pet.id);
        best.set(candidate.pet.id, {
          pet: candidate.pet,
          score: Math.max(score, known?.score ?? -Infinity),
          sameUnknownPet: sameUnknownPet || (known?.sameUnknownPet ?? false),
        });
      }
      const qualifying = [...best.values()].filter((b) => b.sameUnknownPet || b.score >= SUGGESTION_THRESHOLD);
      const nearest = qualifying.sort((a, b) => b.score - a.score)[0];
      if (nearest) pairs.push({ animalId: animal.id, pet: nearest.pet, score: nearest.score });
    }
    // Two Animals wanting the same Pet: the better match wins, and the other gets no Suggestion.
    const suggested = new Set<string>();
    for (const { animalId, pet } of pairs.sort((a, b) => b.score - a.score)) {
      if (suggested.has(pet.id)) continue;
      suggestions.set(animalId, pet);
      suggested.add(pet.id);
    }
    return suggestions;
  }

  return {
    /**
     * The Animals of a Photo, left to right, without those marked "Not a pet".
     * A Photo stored under the same pet model version returns its stored Animals
     * and `detect` is not called. Otherwise `detect` runs and its Animals replace
     * any stored ones, each inheriting the Pet or "Not a pet" mark, and the
     * rejected Suggestions, of an old Animal whose box it mostly overlaps.
     */
    async animalsOfPhoto(photo: PhotoKey, detect: () => Promise<NewAnimal[]>): Promise<Animal[]> {
      if (isCurrent(photo)) return transaction(() => present(photo.sha256));
      const detected = await detect();
      return transaction(() => {
        // Another request for the same Photo may have stored it while this one was detecting.
        if (isCurrent(photo)) return present(photo.sha256);
        const heirs = heirsOf(rowsOf(photo.sha256), boxOf, detected.map((animal) => animal.box), INHERIT_IOU);
        const rejections = rejectionsOfPhoto.all(photo.sha256) as { animal_id: string; pet_id: string }[];
        deleteAnimalsOfPhoto.run(photo.sha256);
        detected.forEach((animal, i) => {
          const from = heirs[i];
          const notAPet = from?.not_a_pet === 1;
          const id = randomUUID();
          insertAnimal.run(
            id,
            photo.sha256,
            animal.box.x,
            animal.box.y,
            animal.box.width,
            animal.box.height,
            notAPet ? null : animal.species,
            notAPet ? null : photo.modelVersion,
            notAPet ? null : new Uint8Array(animal.embedding.buffer, animal.embedding.byteOffset, animal.embedding.byteLength),
            notAPet ? null : (from?.pet_id ?? null),
            notAPet ? 1 : 0,
          );
          if (from && !notAPet) {
            for (const r of rejections) if (r.animal_id === from.id) rejectSuggestion.run(id, r.pet_id);
          }
        });
        // A Photo without Animals keeps nothing, not even its hash, so it is detected on every open.
        if (detected.length > 0) setModelVersionOfPhoto.run(photo.sha256, photo.modelVersion);
        else forgetPhoto.run(photo.sha256);
        deleteEmptyUnknownPets.run();
        return present(photo.sha256);
      });
    },

    /**
     * Names an Animal: the Pet with this name, ignoring case, or a new Pet. Only
     * Pets are looked at, never People. "no-animal" when there is no such
     * Animal, or it is marked "Not a pet".
     */
    nameAnimal(animalId: string, name: string): PetRef | "no-animal" {
      return transaction(() => {
        const animal = findAnimal.get(animalId) as { not_a_pet: number } | undefined;
        if (!animal || animal.not_a_pet === 1) return "no-animal";
        const pet = petNamed(name);
        nameAs(animalId, pet.id);
        return pet;
      });
    },

    /** Names an Animal as the Pet it was suggested as. Only Pets are looked at, never People. */
    confirmSuggestion(animalId: string, petId: string): PetRef | "no-animal" | "no-pet" {
      return transaction(() => {
        if (!photoOfAnimal.get(animalId)) return "no-animal";
        const pet = findPet.get(petId) as PetRef | undefined;
        if (!pet) return "no-pet";
        nameAs(animalId, pet.id);
        return { id: pet.id, name: pet.name };
      });
    },

    /**
     * Remembers that an Animal is not this Pet, so it is never suggested for it
     * again. Returns the Animal as it now stands.
     */
    rejectSuggestion(animalId: string, petId: string): Animal | "no-animal" | "no-pet" {
      return transaction(() => {
        const photo = photoOfAnimal.get(animalId) as { photo_sha256: string } | undefined;
        if (!photo) return "no-animal";
        if (!findPet.get(petId)) return "no-pet";
        rejectSuggestion.run(animalId, petId);
        // Out of an Unknown pet named as this Pet; it then joins another by the usual rule.
        if (leaveUnknownPetOfPet.run(animalId, petId).changes > 0) deleteEmptyUnknownPets.run();
        return present(photo.photo_sha256).find((animal) => animal.id === animalId)!;
      });
    },

    /**
     * Marks an Animal "Not a pet": it keeps only its box and the Photo's hash,
     * and stays hidden whenever the Photo is reopened. False when there is no such Animal.
     */
    markNotAPet(animalId: string): boolean {
      return transaction(() => {
        const marked = markNotAPet.run(animalId).changes > 0;
        forgetRejections.run(animalId);
        deleteEmptyUnknownPets.run();
        return marked;
      });
    },

    /** Every Pet, by name, with how many Animals are named as them. */
    pets: () => listPets.all() as PetSummary[],

    /** "name-taken" when another Pet already has the name, ignoring case. People's names are not looked at. */
    renamePet(petId: string, name: string): PetRef | "no-pet" | "name-taken" {
      return transaction(() => {
        if (!findPet.get(petId)) return "no-pet";
        const holder = findPetByName.get(name) as PetRef | undefined;
        if (holder && holder.id !== petId) return "name-taken";
        renamePet.run(name, petId);
        return { id: petId, name };
      });
    },

    /**
     * Names every Animal of `petId` as `intoPetId` instead, then deletes `petId`.
     * Only Pets are looked at, so a Pet never merges into a Person.
     */
    mergePets(petId: string, intoPetId: string): "merged" | "no-pet" | "same-pet" {
      if (petId === intoPetId) return "same-pet";
      return transaction(() => {
        if (!findPet.get(petId) || !findPet.get(intoPetId)) return "no-pet";
        movePetAnimals.run(intoPetId, petId);
        movePetUnknownPets.run(intoPetId, petId);
        deletePet.run(petId);
        return "merged";
      });
    },

    /**
     * Deletes a Pet; its Animals stay stored, unnamed, and join Unknown pets
     * again by the usual rule. False when there is no such Pet.
     */
    deletePet(petId: string): boolean {
      return transaction(() => {
        const photos = photosOfPet.all(petId) as { photo_sha256: string }[];
        if (deletePet.run(petId).changes === 0) return false;
        deleteEmptyUnknownPets.run();
        for (const { photo_sha256 } of photos) present(photo_sha256);
        return true;
      });
    },

    /** Deletes every Animal, Pet and Unknown pet. Call it inside the face store's transaction. */
    deleteAllRows() {
      db.exec("DELETE FROM animals");
      db.exec("DELETE FROM named_unknown_pets");
      db.exec("DELETE FROM pets");
      db.exec("DELETE FROM animal_photos");
      // AUTOINCREMENT's counter survives, so Unknown pet numbers are never reused (spec #20).
      db.exec("DELETE FROM unknown_pets");
    },
  };

  /**
   * Names an Animal as a Pet, taking it out of its Unknown pet, which is then
   * named as that Pet so that the rest of it are suggested as the Pet.
   */
  function nameAs(animalId: string, petId: string) {
    nameUnknownPet.run(animalId, petId);
    setPetOfAnimal.run(petId, animalId);
    deleteEmptyUnknownPets.run();
  }

  function petNamed(name: string): PetRef {
    const existing = findPetByName.get(name) as PetRef | undefined;
    if (existing) return existing;
    const pet = { id: randomUUID(), name };
    insertPet.run(pet.id, pet.name);
    return pet;
  }
}

/** An Unknown pet's label shows once its unnamed Animals span this many Photos. */
const UNKNOWN_PET_LABEL_PHOTOS = 2;

/** Each Animal shows at most one of its Pet, its Suggestion, or its Unknown pet's label. */
function visible(rows: AnimalRow[], suggestions: Map<string, PetRef>): Animal[] {
  return rows
    .filter((r) => r.not_a_pet === 0)
    .map((r) => {
      const animal: Animal = { id: r.id, species: r.species!, box: boxOf(r) };
      const suggestion = suggestions.get(r.id);
      if (r.pet_id !== null && r.pet_name !== null) animal.pet = { id: r.pet_id, name: r.pet_name };
      else if (suggestion) animal.suggestion = suggestion;
      else if (r.unknown_pet_id !== null && r.unknown_pet_photos >= UNKNOWN_PET_LABEL_PHOTOS) {
        animal.unknownPet = { label: `Unknown pet ${r.unknown_pet_id}`, photoCount: r.unknown_pet_photos };
      }
      return animal;
    });
}

const boxOf = (r: AnimalRow): Box => ({ x: r.box_x, y: r.box_y, width: r.box_width, height: r.box_height });

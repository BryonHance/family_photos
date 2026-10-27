import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Animal, Box, PetRef, PetSummary, Species } from "../../shared/analysis.ts";
import type { PhotoKey } from "../faces/store.ts";
import { heirsOf } from "../faces/overlap.ts";

/**
 * Pet data, kept in faces.db beside face data so that the same delete wipes it
 * and the same backup rule keeps it on the server (ADR-0003): per Animal, its
 * box, species, the Photo's SHA-256, the pet model version, its embedding and
 * its Pet or "Not a pet" mark; and each Pet's name. Pets are not People: they
 * have their own table and their own names. Never the Photo, its name, or any
 * image of an Animal.
 *
 * An Animal marked "Not a pet" keeps only its box and the Photo's hash: its
 * species, embedding, Pet and model version are cleared.
 *
 * Each Photo with stored Animals keeps the pet model version that last read it,
 * apart from the face model version, so that a change to either model detects
 * only its own kind again.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pets (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS animals (
    id            TEXT PRIMARY KEY,
    photo_sha256  TEXT NOT NULL,
    box_x         REAL NOT NULL,
    box_y         REAL NOT NULL,
    box_width     REAL NOT NULL,
    box_height    REAL NOT NULL,
    species       TEXT CHECK (species IN ('cat', 'dog')),
    model_version TEXT,
    embedding     BLOB,
    pet_id        TEXT REFERENCES pets (id) ON DELETE SET NULL,
    not_a_pet     INTEGER NOT NULL DEFAULT 0 CHECK (not_a_pet IN (0, 1)),
    CHECK (not_a_pet = 0 OR (species IS NULL AND embedding IS NULL AND pet_id IS NULL AND model_version IS NULL)),
    CHECK (not_a_pet = 1 OR (species IS NOT NULL AND embedding IS NOT NULL AND model_version IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS animals_by_photo ON animals (photo_sha256);
  CREATE INDEX IF NOT EXISTS animals_by_pet ON animals (pet_id);
  CREATE TABLE IF NOT EXISTS animal_photos (
    sha256        TEXT PRIMARY KEY,
    model_version TEXT NOT NULL
  );
`;

/** An Animal as the pet models found it, before it is stored. */
export type NewAnimal = { species: Species; box: Box; embedding: Float32Array };

export type PetStore = ReturnType<typeof petStore>;

/**
 * A detected Animal whose box overlaps an old one by at least this IoU inherits
 * its Pet or "Not a pet" mark.
 */
const INHERIT_IOU = 0.5;

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
};

/**
 * The pet half of faces.db, on its open database. `transaction` is the face
 * store's, so that both halves take turns the same way.
 */
export function petStore(db: DatabaseSync, transaction: <T>(work: () => T) => T) {
  db.exec(SCHEMA);

  const animalsOfPhotoQuery = db.prepare(`
    SELECT animals.id, box_x, box_y, box_width, box_height, species, pet_id, not_a_pet, pets.name AS pet_name
    FROM animals LEFT JOIN pets ON pets.id = animals.pet_id
    WHERE photo_sha256 = ?
    ORDER BY box_x`);
  const insertAnimal = db.prepare(`
    INSERT INTO animals (id, photo_sha256, box_x, box_y, box_width, box_height, species, model_version, embedding, pet_id, not_a_pet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteAnimalsOfPhoto = db.prepare("DELETE FROM animals WHERE photo_sha256 = ?");
  const findAnimal = db.prepare("SELECT not_a_pet FROM animals WHERE id = ?");
  const setPetOfAnimal = db.prepare("UPDATE animals SET pet_id = ? WHERE id = ?");
  const markNotAPet = db.prepare(
    "UPDATE animals SET not_a_pet = 1, species = NULL, embedding = NULL, pet_id = NULL, model_version = NULL WHERE id = ?",
  );
  const findPetByName = db.prepare("SELECT id, name FROM pets WHERE name = ?");
  const insertPet = db.prepare("INSERT INTO pets (id, name) VALUES (?, ?)");
  const findPet = db.prepare("SELECT id, name FROM pets WHERE id = ?");
  const renamePet = db.prepare("UPDATE pets SET name = ? WHERE id = ?");
  const movePetAnimals = db.prepare("UPDATE animals SET pet_id = ? WHERE pet_id = ?");
  const deletePet = db.prepare("DELETE FROM pets WHERE id = ?");
  const listPets = db.prepare(`
    SELECT pets.id, pets.name, COUNT(animals.id) AS animalCount
    FROM pets LEFT JOIN animals ON animals.pet_id = pets.id
    GROUP BY pets.id
    ORDER BY pets.name`);
  const modelVersionOfPhoto = db.prepare("SELECT model_version FROM animal_photos WHERE sha256 = ?");
  const setModelVersionOfPhoto = db.prepare("INSERT OR REPLACE INTO animal_photos (sha256, model_version) VALUES (?, ?)");
  const forgetPhoto = db.prepare("DELETE FROM animal_photos WHERE sha256 = ?");

  const rowsOf = (sha256: string) => animalsOfPhotoQuery.all(sha256) as AnimalRow[];
  /** True when these pet models last read the Photo, and it has stored Animals. */
  const isCurrent = ({ sha256, modelVersion }: PhotoKey) =>
    (modelVersionOfPhoto.get(sha256) as { model_version: string } | undefined)?.model_version === modelVersion;

  return {
    /**
     * The Animals of a Photo, left to right, without those marked "Not a pet".
     * A Photo stored under the same pet model version returns its stored Animals
     * and `detect` is not called. Otherwise `detect` runs and its Animals replace
     * any stored ones, each inheriting the Pet or "Not a pet" mark of an old
     * Animal whose box it mostly overlaps.
     */
    async animalsOfPhoto(photo: PhotoKey, detect: () => Promise<NewAnimal[]>): Promise<Animal[]> {
      if (isCurrent(photo)) return visible(rowsOf(photo.sha256));
      const detected = await detect();
      return transaction(() => {
        // Another request for the same Photo may have stored it while this one was detecting.
        if (isCurrent(photo)) return visible(rowsOf(photo.sha256));
        const heirs = heirsOf(rowsOf(photo.sha256), boxOf, detected.map((animal) => animal.box), INHERIT_IOU);
        deleteAnimalsOfPhoto.run(photo.sha256);
        detected.forEach((animal, i) => {
          const from = heirs[i];
          const notAPet = from?.not_a_pet === 1;
          insertAnimal.run(
            randomUUID(),
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
        });
        // A Photo without Animals keeps nothing, not even its hash, so it is detected on every open.
        if (detected.length > 0) setModelVersionOfPhoto.run(photo.sha256, photo.modelVersion);
        else forgetPhoto.run(photo.sha256);
        return visible(rowsOf(photo.sha256));
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
        setPetOfAnimal.run(pet.id, animalId);
        return pet;
      });
    },

    /**
     * Marks an Animal "Not a pet": it keeps only its box and the Photo's hash,
     * and stays hidden whenever the Photo is reopened. False when there is no such Animal.
     */
    markNotAPet: (animalId: string): boolean => transaction(() => markNotAPet.run(animalId).changes > 0),

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
        deletePet.run(petId);
        return "merged";
      });
    },

    /** Deletes every Animal and Pet. Call it inside the face store's transaction. */
    deleteAllRows() {
      db.exec("DELETE FROM animals");
      db.exec("DELETE FROM pets");
      db.exec("DELETE FROM animal_photos");
    },
  };

  function petNamed(name: string): PetRef {
    const existing = findPetByName.get(name) as PetRef | undefined;
    if (existing) return existing;
    const pet = { id: randomUUID(), name };
    insertPet.run(pet.id, pet.name);
    return pet;
  }
}

function visible(rows: AnimalRow[]): Animal[] {
  return rows
    .filter((r) => r.not_a_pet === 0)
    .map((r) => {
      const animal: Animal = { id: r.id, species: r.species!, box: boxOf(r) };
      if (r.pet_id !== null && r.pet_name !== null) animal.pet = { id: r.pet_id, name: r.pet_name };
      return animal;
    });
}

const boxOf = (r: AnimalRow): Box => ({ x: r.box_x, y: r.box_y, width: r.box_width, height: r.box_height });

import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { Box } from "../../shared/analysis.ts";
import { heirsOf } from "./overlap.ts";
import type { PhotoKey } from "./photo-key.ts";
import { upgradeTable } from "./schema.ts";
import { cosine, embeddingOf, pairSet } from "./similarity.ts";

/**
 * What Faces and Animals share, in faces.db: how they are stored, named,
 * suggested, placed in Strangers or Unknown pets, and detected again after a
 * model change. The face store (../faces/store.ts) and the pet store
 * (../pets/store.ts) each run it on their own tables, so a Pet's name is never
 * offered for a Face, nor a Person's for an Animal.
 *
 * Here a **region** is a Face or an Animal, a **known** is the Person or Pet
 * it is named as, and an **unknown** is a Stranger or an Unknown pet. These are
 * names for this module only; GLOSSARY.md names the things themselves.
 *
 * A region has exactly one state (specs #12 and #20): named as a known, in an
 * unknown (its Suggestion, if any, is worked out afresh each time the Photo is
 * opened), or marked "Not a face" or "Not a pet". The tables' CHECKs refuse
 * any other mix. A region so marked keeps only its box and the Photo's hash.
 *
 * Each rejected Suggestion is kept as the pair of region and known, so that it
 * is never suggested again. An unknown is only a number: its regions point to
 * it. AUTOINCREMENT keeps a number from ever being reused once its unknown
 * empties. Naming one of its regions takes that region out, and keeps the pair
 * of unknown and known so that the rest are suggested as that known.
 *
 * Each Photo with stored regions keeps the model version that last read it, by
 * its hash, so that a model change detects it again even when all its regions
 * are marked "Not a …" and so carry no model version of their own. Faces and
 * Animals keep theirs apart, so that a change to either model detects only its
 * own kind again.
 */

/** The names of one kind's tables and columns, as its store creates them. */
export type RegionTables = {
  /** `faces`: per region, its box, the Photo's SHA-256, the model version, its embedding, known, unknown and mark. */
  regions: string;
  /** `not_a_face`: 1 when the region is marked "Not a …". */
  notA: string;
  /** `people`: each known's `id` and `name`. */
  knowns: string;
  /** `person_id`: a known's id, in the regions table and those below. */
  knownId: string;
  /** `strangers`: one AUTOINCREMENT `id` per unknown. */
  unknowns: string;
  /** `stranger_id`: an unknown's id, in the regions table and `namedUnknowns`. */
  unknownId: string;
  /** `rejected_suggestions`: pairs of `rejectionRegionId` and `knownId`. */
  rejections: string;
  /** `face_id` */
  rejectionRegionId: string;
  /** `named_strangers`: pairs of `unknownId` and `knownId`. */
  namedUnknowns: string;
  /** `photos`: each Photo's `sha256` and the `model_version` that last read it. */
  photos: string;
  /** Columns a region keeps beyond the shared ones, such as an Animal's `species`; cleared when it is marked. */
  extraColumns: string[];
};

/** A region as the detector found it, before it is stored. */
export type NewRegion = { box: Box; embedding: Float32Array };

/** A known as a region refers to it: a PersonRef or a PetRef. */
export type KnownRef = { id: string; name: string };

/**
 * A stored region as the Analysis shows it, before its store gives it its
 * own nouns. It has at most one of `known`, `suggestion` and `unknown`.
 */
export type ShownRegion = {
  id: string;
  box: Box;
  /** The region's `extraColumns`, by name. */
  extra: Record<string, SQLOutputValue>;
  known?: KnownRef;
  suggestion?: KnownRef;
  /** Its unknown's number, shown once its unnamed regions span UNKNOWN_LABEL_PHOTOS Photos. */
  unknown?: { id: number; photoCount: number };
};

export type RegionRules<New extends NewRegion, Shown extends { id: string }> = {
  tables: RegionTables;
  /** The regions table's columns and constraints, in parentheses, as `upgradeTable` takes them. */
  definition: string;
  /** Every table of the kind, each `CREATE TABLE IF NOT EXISTS`. */
  createTables: string;
  createIndexes: string;
  /** A region is suggested as the known of its nearest named region at or above this. */
  suggestionThreshold: number;
  /** An unnamed region joins the unknown of its most similar region at or above this. */
  unknownThreshold: number;
  /** The values of `tables.extraColumns` for a detected region, in order. */
  extraValues: (region: New) => SQLInputValue[];
  /** The region as its kind shows it in the Analysis. */
  show: (region: ShownRegion) => Shown;
};

/**
 * A detected region whose box overlaps an old one by at least this IoU inherits
 * its known or "Not a …" mark, and its rejected Suggestions.
 */
const INHERIT_IOU = 0.5;

/** An unknown's label shows once its unnamed regions span this many Photos. */
const UNKNOWN_LABEL_PHOTOS = 2;

type RegionRow = {
  id: string;
  box_x: number;
  box_y: number;
  box_width: number;
  box_height: number;
  known_id: string | null;
  known_name: string | null;
  not_a: number;
  unknown_id: number | null;
  /** How many Photos the unnamed regions of its unknown span. */
  unknown_photos: number;
  [extra: string]: SQLOutputValue;
};

type EmbeddingRow = {
  id: string;
  embedding: Uint8Array;
  model_version: string | null;
  known_id: string | null;
  unknown_id: number | null;
};

type NamedRow = {
  photo_sha256: string;
  embedding: Uint8Array;
  known_id: string;
  known_name: string;
};

/**
 * One kind of region on the open faces.db: creates or upgrades its tables, then
 * stores, names and suggests its regions. `transaction` is shared by every kind,
 * so that they take turns the same way.
 */
export function regionStore<New extends NewRegion, Shown extends { id: string }>(
  db: DatabaseSync,
  transaction: <T>(work: () => T) => T,
  rules: RegionRules<New, Shown>,
) {
  const {
    regions,
    notA,
    knowns,
    knownId,
    unknowns,
    unknownId,
    rejections,
    rejectionRegionId,
    namedUnknowns,
    photos,
    extraColumns,
  } = rules.tables;

  db.exec(rules.createTables);
  // faces.db files made before Strangers and Unknown pets lack the column.
  const columns = db.prepare(`PRAGMA table_info(${regions})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === unknownId)) {
    db.exec(`ALTER TABLE ${regions} ADD COLUMN ${unknownId} INTEGER REFERENCES ${unknowns} (id) ON DELETE SET NULL`);
  }
  // faces.db files made before a region had one state kept a named region in its
  // unknown: it leaves, and the unknown remembers it was named so.
  upgradeTable(
    db,
    regions,
    rules.definition,
    `INSERT OR IGNORE INTO ${namedUnknowns} (${unknownId}, ${knownId})
       SELECT ${unknownId}, ${knownId} FROM ${regions} WHERE ${knownId} IS NOT NULL AND ${unknownId} IS NOT NULL;
     UPDATE ${regions} SET ${unknownId} = NULL WHERE ${knownId} IS NOT NULL;`,
  );
  db.exec(rules.createIndexes);

  const extraSelect = extraColumns.map((column) => `, ${column}`).join("");
  const regionsOfPhotoQuery = db.prepare(`
    SELECT ${regions}.id, box_x, box_y, box_width, box_height${extraSelect},
           ${knownId} AS known_id, ${notA} AS not_a, ${unknownId} AS unknown_id,
           ${knowns}.name AS known_name,
           (SELECT COUNT(DISTINCT member.photo_sha256) FROM ${regions} AS member
            WHERE member.${unknownId} = ${regions}.${unknownId}) AS unknown_photos
    FROM ${regions} LEFT JOIN ${knowns} ON ${knowns}.id = ${regions}.${knownId}
    WHERE photo_sha256 = ?
    ORDER BY box_x`);
  const insertColumns = ["id", "photo_sha256", "box_x", "box_y", "box_width", "box_height", ...extraColumns]
    .concat(["model_version", "embedding", knownId, notA]);
  const insertRegion = db.prepare(
    `INSERT INTO ${regions} (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`,
  );
  const deleteRegionsOfPhoto = db.prepare(`DELETE FROM ${regions} WHERE photo_sha256 = ?`);
  const findRegion = db.prepare(`SELECT ${notA} AS not_a FROM ${regions} WHERE id = ?`);
  // Naming a region takes it out of its unknown, which remembers the known for the rest.
  const nameUnknown = db.prepare(`
    INSERT OR IGNORE INTO ${namedUnknowns} (${unknownId}, ${knownId})
    SELECT ${unknownId}, ?2 FROM ${regions} WHERE id = ?1 AND ${unknownId} IS NOT NULL`);
  const setKnownOfRegion = db.prepare(`UPDATE ${regions} SET ${knownId} = ?, ${unknownId} = NULL WHERE id = ?`);
  const markNotA = db.prepare(
    `UPDATE ${regions} SET ${notA} = 1${extraColumns.map((column) => `, ${column} = NULL`).join("")},
       embedding = NULL, ${knownId} = NULL, model_version = NULL, ${unknownId} = NULL
     WHERE id = ?`,
  );
  const findKnownByName = db.prepare(`SELECT id, name FROM ${knowns} WHERE name = ?`);
  const insertKnown = db.prepare(`INSERT INTO ${knowns} (id, name) VALUES (?, ?)`);
  const findKnown = db.prepare(`SELECT id, name FROM ${knowns} WHERE id = ?`);
  const renameKnown = db.prepare(`UPDATE ${knowns} SET name = ? WHERE id = ?`);
  const moveKnownRegions = db.prepare(`UPDATE ${regions} SET ${knownId} = ? WHERE ${knownId} = ?`);
  // Those left behind go with the merged known, by ON DELETE CASCADE.
  const moveKnownUnknowns = db.prepare(`UPDATE OR IGNORE ${namedUnknowns} SET ${knownId} = ? WHERE ${knownId} = ?`);
  // Its regions are left unnamed by ON DELETE SET NULL, and its unknowns no longer named so by ON DELETE CASCADE.
  const deleteKnown = db.prepare(`DELETE FROM ${knowns} WHERE id = ?`);
  const listKnowns = db.prepare(`
    SELECT ${knowns}.id, ${knowns}.name, COUNT(${regions}.id) AS regionCount
    FROM ${knowns} LEFT JOIN ${regions} ON ${regions}.${knownId} = ${knowns}.id
    GROUP BY ${knowns}.id
    ORDER BY ${knowns}.name`);

  // Every named region's embedding, for Suggestions: a plain scan, no vector
  // index (spec #12), never mixing Faces with Animals (spec #20).
  const namedRegions = db.prepare(`
    SELECT photo_sha256, embedding, ${knownId} AS known_id, ${knowns}.name AS known_name
    FROM ${regions} JOIN ${knowns} ON ${knowns}.id = ${regions}.${knownId}
    WHERE model_version = ?`);
  const embeddingsOfPhoto = db.prepare(`
    SELECT id, embedding, model_version, ${knownId} AS known_id, ${unknownId} AS unknown_id
    FROM ${regions} WHERE photo_sha256 = ? AND embedding IS NOT NULL`);
  // The unnamed regions of every unknown, for regions looking for one to join.
  const unknownMembers = db.prepare(`
    SELECT photo_sha256, embedding, ${unknownId} AS unknown_id FROM ${regions}
    WHERE ${unknownId} IS NOT NULL AND model_version = ?`);
  // The knowns each unknown of a Photo's regions was named as, through one of its regions.
  const namesOfUnknowns = db.prepare(`
    SELECT DISTINCT ${namedUnknowns}.${unknownId} AS unknown_id, ${namedUnknowns}.${knownId} AS known_id
    FROM ${namedUnknowns} JOIN ${regions} ON ${regions}.${unknownId} = ${namedUnknowns}.${unknownId}
    WHERE ${regions}.photo_sha256 = ?`);
  // For each region of a Photo, the unknowns it must not join: those named as a
  // known it rejected.
  const barredUnknowns = db.prepare(`
    SELECT ${rejections}.${rejectionRegionId} AS region_id, ${namedUnknowns}.${unknownId} AS unknown_id
    FROM ${rejections}
    JOIN ${regions} ON ${regions}.id = ${rejections}.${rejectionRegionId}
    JOIN ${namedUnknowns} ON ${namedUnknowns}.${knownId} = ${rejections}.${knownId}
    WHERE ${regions}.photo_sha256 = ?`);
  const photosOfKnown = db.prepare(`SELECT DISTINCT photo_sha256 FROM ${regions} WHERE ${knownId} = ?`);
  const leaveUnknownOfKnown = db.prepare(`
    UPDATE ${regions} SET ${unknownId} = NULL
    WHERE id = ?1 AND ${unknownId} IN (SELECT ${unknownId} FROM ${namedUnknowns} WHERE ${knownId} = ?2)`);
  const newUnknown = db.prepare(`INSERT INTO ${unknowns} DEFAULT VALUES`);
  const setUnknownOfRegion = db.prepare(`UPDATE ${regions} SET ${unknownId} = ? WHERE id = ?`);
  const deleteEmptyUnknowns = db.prepare(
    `DELETE FROM ${unknowns} WHERE id NOT IN (SELECT ${unknownId} FROM ${regions} WHERE ${unknownId} IS NOT NULL)`,
  );
  const rejectionsOfPhoto = db.prepare(`
    SELECT ${rejectionRegionId} AS region_id, ${rejections}.${knownId} AS known_id
    FROM ${rejections} JOIN ${regions} ON ${regions}.id = ${rejections}.${rejectionRegionId}
    WHERE photo_sha256 = ?`);
  const rejectSuggestion = db.prepare(
    `INSERT OR IGNORE INTO ${rejections} (${rejectionRegionId}, ${knownId}) VALUES (?, ?)`,
  );
  const forgetRejections = db.prepare(`DELETE FROM ${rejections} WHERE ${rejectionRegionId} = ?`);
  const photoOfRegion = db.prepare(`SELECT photo_sha256 FROM ${regions} WHERE id = ? AND ${notA} = 0`);

  const modelVersionOfPhoto = db.prepare(`SELECT model_version FROM ${photos} WHERE sha256 = ?`);
  const setModelVersionOfPhoto = db.prepare(`INSERT OR REPLACE INTO ${photos} (sha256, model_version) VALUES (?, ?)`);
  const forgetPhoto = db.prepare(`DELETE FROM ${photos} WHERE sha256 = ?`);

  const rowsOf = (sha256: string) => regionsOfPhotoQuery.all(sha256) as RegionRow[];
  /** True when these models last read the Photo, and it has stored regions. */
  const isCurrent = ({ sha256, modelVersion }: PhotoKey) =>
    (modelVersionOfPhoto.get(sha256) as { model_version: string } | undefined)?.model_version === modelVersion;

  /**
   * The regions of a stored Photo as the Analysis shows them, after placing each
   * unnamed region that has no Suggestion and no unknown in one. Call it inside a transaction.
   */
  function present(sha256: string): Shown[] {
    let suggestions = suggestionsFor(sha256);
    if (joinUnknowns(sha256, suggestions)) suggestions = suggestionsFor(sha256);
    return visible(rowsOf(sha256), suggestions).map(rules.show);
  }

  /**
   * Places each unnamed region of a Photo that has no Suggestion and no unknown:
   * it joins the unknown of its most similar unnamed region in another Photo, at
   * or above the unknown threshold, or starts a new one. Each region chooses on
   * its own, so two regions of one Photo may join the same unknown. A region
   * never joins an unknown named as a known it rejected. Unknowns never merge.
   * True when any region was placed.
   */
  function joinUnknowns(sha256: string, suggestions: Map<string, KnownRef>): boolean {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const waiting = own.filter((r) => r.known_id === null && r.unknown_id === null && !suggestions.has(r.id));
    const modelVersion = waiting[0]?.model_version;
    if (modelVersion == null) return false;
    const barred = pairSet(
      (barredUnknowns.all(sha256) as { region_id: string; unknown_id: number }[]).map((r) => [r.region_id, r.unknown_id] as const),
    );
    const members = (unknownMembers.all(modelVersion) as { photo_sha256: string; embedding: Uint8Array; unknown_id: number }[])
      .filter((m) => m.photo_sha256 !== sha256)
      .map((m) => ({ unknownId: m.unknown_id, embedding: embeddingOf(m.embedding) }));

    for (const region of waiting) {
      const embedding = embeddingOf(region.embedding);
      let nearest: { unknownId: number; score: number } | undefined;
      for (const member of members) {
        if (barred.has(region.id, member.unknownId)) continue;
        const score = cosine(embedding, member.embedding);
        if (score >= rules.unknownThreshold && score > (nearest?.score ?? -Infinity)) {
          nearest = { unknownId: member.unknownId, score };
        }
      }
      setUnknownOfRegion.run(nearest?.unknownId ?? newUnknown.run().lastInsertRowid, region.id);
    }
    return true;
  }

  /**
   * Each unnamed region's Suggestion: the known of its nearest named region in
   * another Photo, at or above the suggestion threshold; but a known its unknown
   * was named as comes first, however alike they are; unless the user rejected
   * that known for it. An Animal's species does not limit it: the detector's
   * species is a hint, not a fact about the Pet. A known already named in this
   * Photo is not suggested, and no two regions of one Photo are suggested as the
   * same known: the better match wins, and the other region gets no Suggestion
   * at all (it then follows the unknown rule), never its next-best known.
   */
  function suggestionsFor(sha256: string): Map<string, KnownRef> {
    const own = embeddingsOfPhoto.all(sha256) as EmbeddingRow[];
    const modelVersion = own[0]?.model_version;
    const unnamed = own.filter((region) => region.known_id === null);
    const suggestions = new Map<string, KnownRef>();
    if (modelVersion == null || unnamed.length === 0) return suggestions;
    const namedHere = new Set(own.map((region) => region.known_id));
    const named = (namedRegions.all(modelVersion) as NamedRow[])
      .filter((row) => row.photo_sha256 !== sha256 && !namedHere.has(row.known_id))
      .map((row) => ({
        known: { id: row.known_id, name: row.known_name },
        embedding: embeddingOf(row.embedding),
      }));

    const rejected = pairSet(
      (rejectionsOfPhoto.all(sha256) as { region_id: string; known_id: string }[]).map((r) => [r.region_id, r.known_id] as const),
    );
    const namedAs = pairSet(
      (namesOfUnknowns.all(sha256) as { unknown_id: number; known_id: string }[]).map((r) => [r.unknown_id, r.known_id] as const),
    );

    // Each region's own best known first; only then are clashes settled.
    const pairs: { regionId: string; known: KnownRef; score: number }[] = [];
    for (const region of unnamed) {
      const embedding = embeddingOf(region.embedding);
      const best = new Map<string, { known: KnownRef; score: number; sameUnknown: boolean }>();
      for (const candidate of named) {
        if (rejected.has(region.id, candidate.known.id)) continue;
        const score = cosine(embedding, candidate.embedding);
        const sameUnknown = region.unknown_id !== null && namedAs.has(region.unknown_id, candidate.known.id);
        const seen = best.get(candidate.known.id);
        best.set(candidate.known.id, {
          known: candidate.known,
          score: Math.max(score, seen?.score ?? -Infinity),
          sameUnknown: sameUnknown || (seen?.sameUnknown ?? false),
        });
      }
      // A known its unknown was named as comes before any other, however near ("Naming one of its
      // Faces makes the rest Suggestions", spec #12).
      const candidates = [...best.values()];
      const ofItsGroup = candidates.filter((b) => b.sameUnknown);
      const qualifying =
        ofItsGroup.length > 0 ? ofItsGroup : candidates.filter((b) => b.score >= rules.suggestionThreshold);
      const nearest = qualifying.sort((a, b) => b.score - a.score)[0];
      if (nearest) pairs.push({ regionId: region.id, known: nearest.known, score: nearest.score });
    }
    // Two regions wanting the same known: the better match wins, and the other gets no Suggestion.
    const suggested = new Set<string>();
    for (const { regionId, known } of pairs.sort((a, b) => b.score - a.score)) {
      if (suggested.has(known.id)) continue;
      suggestions.set(regionId, known);
      suggested.add(known.id);
    }
    return suggestions;
  }

  /** Each region shows at most one of its known, its Suggestion, or its unknown's label. */
  function visible(rows: RegionRow[], suggestions: Map<string, KnownRef>): ShownRegion[] {
    return rows
      .filter((r) => r.not_a === 0)
      .map((r) => {
        const region: ShownRegion = {
          id: r.id,
          box: boxOf(r),
          extra: Object.fromEntries(extraColumns.map((column) => [column, r[column]!])),
        };
        const suggestion = suggestions.get(r.id);
        if (r.known_id !== null && r.known_name !== null) region.known = { id: r.known_id, name: r.known_name };
        else if (suggestion) region.suggestion = suggestion;
        else if (r.unknown_id !== null && r.unknown_photos >= UNKNOWN_LABEL_PHOTOS) {
          region.unknown = { id: r.unknown_id, photoCount: r.unknown_photos };
        }
        return region;
      });
  }

  /**
   * Names a region as a known, taking it out of its unknown, which is then
   * named as that known so that the rest of it are suggested as the known.
   */
  function nameAs(regionId: string, knownId: string) {
    nameUnknown.run(regionId, knownId);
    setKnownOfRegion.run(knownId, regionId);
    deleteEmptyUnknowns.run();
  }

  function knownNamed(name: string): KnownRef {
    const existing = findKnownByName.get(name) as KnownRef | undefined;
    if (existing) return existing;
    const known = { id: randomUUID(), name };
    insertKnown.run(known.id, known.name);
    return known;
  }

  return {
    /**
     * The regions of a Photo, left to right, without those marked "Not a …".
     * A Photo stored under the same model version returns its stored regions
     * and `detect` is not called. Otherwise `detect` runs and its regions
     * replace any stored ones, each inheriting the known or "Not a …" mark, and
     * the rejected Suggestions, of an old region whose box it mostly overlaps.
     */
    async regionsOfPhoto(photo: PhotoKey, detect: () => Promise<New[]>): Promise<Shown[]> {
      if (isCurrent(photo)) return transaction(() => present(photo.sha256));
      const detected = await detect();
      return transaction(() => {
        // Another request for the same Photo may have stored it while this one was detecting.
        if (isCurrent(photo)) return present(photo.sha256);
        const heirs = heirsOf(rowsOf(photo.sha256), boxOf, detected.map((region) => region.box), INHERIT_IOU);
        const rejections = rejectionsOfPhoto.all(photo.sha256) as { region_id: string; known_id: string }[];
        deleteRegionsOfPhoto.run(photo.sha256);
        detected.forEach((region, i) => {
          const from = heirs[i];
          const marked = from?.not_a === 1;
          const id = randomUUID();
          const { embedding } = region;
          insertRegion.run(
            id,
            photo.sha256,
            region.box.x,
            region.box.y,
            region.box.width,
            region.box.height,
            ...(marked ? extraColumns.map(() => null) : rules.extraValues(region)),
            marked ? null : photo.modelVersion,
            marked ? null : new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            marked ? null : (from?.known_id ?? null),
            marked ? 1 : 0,
          );
          if (from && !marked) {
            for (const r of rejections) if (r.region_id === from.id) rejectSuggestion.run(id, r.known_id);
          }
        });
        // A Photo without regions keeps nothing, not even its hash, so it is detected on every open.
        if (detected.length > 0) setModelVersionOfPhoto.run(photo.sha256, photo.modelVersion);
        else forgetPhoto.run(photo.sha256);
        deleteEmptyUnknowns.run();
        return present(photo.sha256);
      });
    },

    /**
     * The regions of the Photo this region is in, as reopening the Photo would
     * show them now, such as after a known is merged or deleted. "no-region"
     * when there is no such region, or it is marked "Not a …".
     */
    regionsOfPhotoOf(regionId: string): Shown[] | "no-region" {
      return transaction(() => {
        const photo = photoOfRegion.get(regionId) as { photo_sha256: string } | undefined;
        return photo ? present(photo.photo_sha256) : "no-region";
      });
    },

    /**
     * Names a region: the known of its kind with this name, ignoring case, or a
     * new one. "no-region" when there is no such region, or it is marked "Not a …".
     */
    name(regionId: string, name: string): KnownRef | "no-region" {
      return transaction(() => {
        const region = findRegion.get(regionId) as { not_a: number } | undefined;
        if (!region || region.not_a === 1) return "no-region";
        const known = knownNamed(name);
        nameAs(regionId, known.id);
        return known;
      });
    },

    /** Names a region as the known it was suggested as. */
    confirmSuggestion(regionId: string, knownId: string): KnownRef | "no-region" | "no-known" {
      return transaction(() => {
        if (!photoOfRegion.get(regionId)) return "no-region";
        const known = findKnown.get(knownId) as KnownRef | undefined;
        if (!known) return "no-known";
        nameAs(regionId, known.id);
        return { id: known.id, name: known.name };
      });
    },

    /**
     * Remembers that a region is not this known, so it is never suggested for
     * it again. Returns the region as it now stands.
     */
    rejectSuggestion(regionId: string, knownId: string): Shown | "no-region" | "no-known" {
      return transaction(() => {
        const photo = photoOfRegion.get(regionId) as { photo_sha256: string } | undefined;
        if (!photo) return "no-region";
        if (!findKnown.get(knownId)) return "no-known";
        rejectSuggestion.run(regionId, knownId);
        // Out of an unknown named as this known; it then joins another by the usual rule.
        if (leaveUnknownOfKnown.run(regionId, knownId).changes > 0) deleteEmptyUnknowns.run();
        return present(photo.photo_sha256).find((region) => region.id === regionId)!;
      });
    },

    /**
     * Marks a region "Not a …": it keeps only its box and the Photo's hash, and
     * stays hidden whenever the Photo is reopened. False when there is no such region.
     */
    markNotA(regionId: string): boolean {
      return transaction(() => {
        const marked = markNotA.run(regionId).changes > 0;
        forgetRejections.run(regionId);
        deleteEmptyUnknowns.run();
        return marked;
      });
    },

    /** Every known of the kind, by name, with how many regions are named as them. */
    knowns: () => listKnowns.all() as (KnownRef & { regionCount: number })[],

    /** "name-taken" when another known of the kind already has the name, ignoring case. */
    rename(knownId: string, name: string): KnownRef | "no-known" | "name-taken" {
      return transaction(() => {
        if (!findKnown.get(knownId)) return "no-known";
        const holder = findKnownByName.get(name) as KnownRef | undefined;
        if (holder && holder.id !== knownId) return "name-taken";
        renameKnown.run(name, knownId);
        return { id: knownId, name };
      });
    },

    /** Names every region of `knownId` as `intoKnownId` instead, then deletes `knownId`. */
    merge(knownId: string, intoKnownId: string): "merged" | "no-known" | "same-known" {
      if (knownId === intoKnownId) return "same-known";
      return transaction(() => {
        if (!findKnown.get(knownId) || !findKnown.get(intoKnownId)) return "no-known";
        moveKnownRegions.run(intoKnownId, knownId);
        moveKnownUnknowns.run(intoKnownId, knownId);
        deleteKnown.run(knownId);
        return "merged";
      });
    },

    /**
     * Deletes a known; its regions stay stored, unnamed, and join unknowns
     * again by the usual rule. False when there is no such known.
     */
    delete(knownId: string): boolean {
      return transaction(() => {
        const photos = photosOfKnown.all(knownId) as { photo_sha256: string }[];
        if (deleteKnown.run(knownId).changes === 0) return false;
        deleteEmptyUnknowns.run();
        for (const { photo_sha256 } of photos) present(photo_sha256);
        return true;
      });
    },

    /** Deletes every region, known and unknown of the kind. Call it inside a transaction. */
    deleteAllRows() {
      db.exec(`DELETE FROM ${regions}`);
      db.exec(`DELETE FROM ${namedUnknowns}`);
      db.exec(`DELETE FROM ${knowns}`);
      db.exec(`DELETE FROM ${photos}`);
      // AUTOINCREMENT's counter survives, so unknown numbers are never reused (specs #12 and #20).
      db.exec(`DELETE FROM ${unknowns}`);
    },
  };
}

const boxOf = (r: { box_x: number; box_y: number; box_width: number; box_height: number }): Box => ({
  x: r.box_x,
  y: r.box_y,
  width: r.box_width,
  height: r.box_height,
});

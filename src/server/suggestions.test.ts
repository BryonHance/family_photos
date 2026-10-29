import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FaceDetector } from "./faces/detector.ts";
import { fixture, openApi, type Api } from "./testing/api.ts";
import { loadTestFaceDetector } from "./testing/models.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
// crew.jpg shows three Faces, left to right: Armstrong, Collins, Aldrin.
// crew-rotated.jpg is another Photo (other bytes) of the same three, upright the same.
// armstrong-twice.jpg shows Armstrong twice: cropped from crew.jpg, then beside it mirrored.

let exiftool: ExifTool;
let faceDetector: FaceDetector;
let api: Api;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadTestFaceDetector();
});

afterAll(async () => {
  await exiftool.end();
});

beforeEach(async () => {
  api = await openApi({ exiftool, faceDetector });
});

afterEach(async () => {
  await api.close();
});

const strangerLabels = (faces: { stranger?: { label: string; photoCount: number } }[]) =>
  faces.map((face) => face.stranger && `${face.stranger.label}, in ${face.stranger.photoCount} Photos`);

const suggestedNames = (faces: { suggestion?: { name: string } }[]) => faces.map((face) => face.suggestion?.name);

/**
 * The real models finding a Photo's Faces, standing in an embedding for each,
 * left to right: `vectors[i]` maps axes to weights, made unit length. A Face
 * without one gets an axis of its own, unlike any other.
 */
const facesWith = (...vectors: Record<number, number>[]): FaceDetector => ({
  modelVersion: faceDetector.modelVersion,
  detect: async (photo) => {
    const faces = (await faceDetector.detect(photo)).sort((a, b) => a.box.x - b.box.x);
    return faces.map((face, i) => {
      const embedding = new Float32Array(512);
      for (const [axis, weight] of Object.entries(vectors[i] ?? { [100 + i]: 1 })) embedding[Number(axis)] = weight;
      const length = Math.hypot(...embedding);
      return { ...face, embedding: embedding.map((v) => v / length) };
    });
  },
});

describe("Suggestions", () => {
  it("suggests the Person of a named Face for the same Face in another Photo", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");

    const faces = (await api.upload("crew-rotated.jpg")).faces;

    expect(faces[0]!.suggestion).toEqual(neil);
    expect(faces[0]!.person).toBeUndefined();
    expect(suggestedNames(faces)).toEqual(["Neil", undefined, undefined]);
  });

  it("confirming a Suggestion names the Face", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;

    expect(await api.confirmSuggestion(suggested!.id, neil.id)).toEqual(neil);

    const [reopened] = (await api.upload("crew-rotated.jpg")).faces;
    expect(reopened!.person).toEqual(neil);
    expect(reopened!.suggestion).toBeUndefined();
    expect((await api.people()).map((p) => p.faceCount)).toEqual([2]);
  });

  it("a rejected Suggestion never returns, and ignoring one saves nothing", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;
    const ignored = await api.upload("crew-rotated.jpg");
    expect(ignored.faces[0]!.suggestion).toEqual(neil);

    const afterRejecting = await api.rejectSuggestion(suggested!.id, neil.id);

    expect(afterRejecting.suggestion).toBeUndefined();
    expect(afterRejecting.person).toBeUndefined();
    const [reopened] = (await api.upload("crew-rotated.jpg")).faces;
    expect(reopened!.suggestion).toBeUndefined();
    expect(reopened!.person).toBeUndefined();
  });

  it("never suggests two Faces of one Photo as the same Person: the better match wins", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(armstrong!.id, "Neil");

    const twice = (await api.upload("armstrong-twice.jpg")).faces;

    // The left-hand Face is the crop as it was; the right-hand one is mirrored.
    expect(twice).toHaveLength(2);
    expect(suggestedNames(twice)).toEqual(["Neil", undefined]);
  });

  it("leaves the Face that loses a clash without a Suggestion, rather than its next-best Person", async () => {
    // Neil is axis 0 and Buzz axis 1. Both Faces of the second Photo are nearest to Neil,
    // the right-hand one less so; it is like Buzz too, but less than like Neil.
    const crew = (await api.upload("crew.jpg", { detector: facesWith({ 0: 1 }, { 1: 1 }, { 2: 1 }) })).faces;
    const neil = await api.nameFace(crew[0]!.id, "Neil");
    await api.nameFace(crew[1]!.id, "Buzz");

    const twice = (
      await api.upload("armstrong-twice.jpg", {
        detector: facesWith({ 0: 0.8, 1: 0.55, 3: Math.sqrt(0.0575) }, { 0: 0.7, 1: 0.6, 4: Math.sqrt(0.15) }),
      })
    ).faces;

    expect(twice.map((face) => face.suggestion)).toEqual([neil, undefined]);
    // It then follows the Stranger rule: alone in a new Stranger, it shows no label.
    expect(twice[1]!.stranger).toBeUndefined();
  });

  it("does not suggest a Person already named in the same Photo", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(armstrong!.id, "Neil");
    const [left, right] = (await api.upload("armstrong-twice.jpg")).faces;

    await api.nameFace(left!.id, "Neil");

    const [, reopenedRight] = (await api.upload("armstrong-twice.jpg")).faces;
    expect(reopenedRight!.id).toBe(right!.id);
    expect(reopenedRight!.suggestion).toBeUndefined();
  });

  it("refuses to confirm or reject for an unknown Face or Person", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;

    for (const verb of ["confirm", "reject"]) {
      expect((await api.call("POST", `/api/faces/no-such-face/suggestion/${verb}`, { personId: neil.id })).status).toBe(404);
      expect((await api.call("POST", `/api/faces/${suggested!.id}/suggestion/${verb}`, { personId: "nobody" })).status).toBe(404);
      expect((await api.call("POST", `/api/faces/${suggested!.id}/suggestion/${verb}`, {})).status).toBe(400);
    }
    expect((await api.upload("crew-rotated.jpg")).faces[0]!.suggestion).toEqual(neil);
  });
});

describe("Strangers", () => {
  it("labels unnamed look-alike Faces across two Photos alike, with how many Photos they span", async () => {
    const first = (await api.upload("crew.jpg")).faces;
    // A Stranger in a single Photo shows no label.
    expect(strangerLabels(first)).toEqual([undefined, undefined, undefined]);

    const second = (await api.upload("crew-rotated.jpg")).faces;

    const labels = strangerLabels(second);
    expect(labels).toEqual([
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
    ]);
    expect(new Set(labels).size).toBe(3);
    expect(strangerLabels((await api.upload("crew.jpg")).faces)).toEqual(labels);
    expect(second.every((face) => face.person === undefined && face.suggestion === undefined)).toBe(true);
  });

  it('never reuses a Stranger number, even after "Delete all face and pet data"', async () => {
    await api.upload("crew.jpg");
    const before = strangerLabels((await api.upload("crew-rotated.jpg")).faces);

    await api.deleteAllFaceAndPetData();

    await api.upload("crew.jpg");
    const after = strangerLabels((await api.upload("crew-rotated.jpg")).faces);
    expect(after.every((label) => label !== undefined)).toBe(true);
    for (const label of after) expect(before).not.toContain(label);
  });

  it("lets two Faces of one Photo join the same Stranger, each the one of its most similar Face", async () => {
    await api.upload("crew.jpg", { detector: facesWith({ 0: 1 }, { 1: 1 }, { 2: 1 }) });

    const twice = (
      await api.upload("armstrong-twice.jpg", {
        detector: facesWith({ 0: 0.9, 3: Math.sqrt(0.19) }, { 0: 0.8, 4: 0.6 }),
      })
    ).faces;

    expect(strangerLabels(twice)).toEqual([
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
    ]);
    expect(twice[1]!.stranger).toEqual(twice[0]!.stranger);
  });

  it("gives the Faces of a Photo as they now stand, by one of its Faces, such as after their Person is deleted", async () => {
    await api.upload("crew.jpg");
    const [first] = (await api.upload("crew-rotated.jpg")).faces;
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    await api.confirmSuggestion(first!.id, neil.id);

    await api.deletePerson(neil.id);

    const now = await api.facesOfPhotoOf(armstrong!.id);
    expect(now[0]!.stranger?.photoCount).toBe(2);
    expect(now).toEqual((await api.upload("crew.jpg")).faces);
    expect((await api.call("GET", "/api/faces/no-such-face/photo")).status).toBe(404);
  });

  it("the Faces of a deleted Person join a Stranger again, under a number never used before", async () => {
    await api.upload("crew.jpg");
    const before = (await api.upload("crew-rotated.jpg")).faces;
    const usedLabels = before.map((face) => face.stranger!.label);
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    await api.confirmSuggestion(before[0]!.id, neil.id);

    await api.deletePerson(neil.id);

    const crew = (await api.upload("crew.jpg")).faces;
    const rotated = (await api.upload("crew-rotated.jpg")).faces;
    expect(crew[0]!.person).toBeUndefined();
    expect(crew[0]!.stranger).toEqual(rotated[0]!.stranger);
    expect(crew[0]!.stranger?.photoCount).toBe(2);
    expect(usedLabels).not.toContain(crew[0]!.stranger?.label);
    // The other two Strangers are untouched.
    expect(strangerLabels(rotated).slice(1)).toEqual(strangerLabels(before).slice(1));
  });

  describe("a chain of look-alikes", () => {
    /**
     * The real models finding the first Face of a Photo, standing in an
     * embedding `degrees` round a circle: Faces 40° apart are alike (cosine
     * 0.77), Faces 80° apart are not (0.17). The fixtures' real Faces are either
     * near-identical or wholly unlike, so they cannot make a chain.
     */
    const firstFaceAt = (degrees: number): FaceDetector => ({
      modelVersion: faceDetector.modelVersion,
      detect: async (photo) => {
        const [face] = await faceDetector.detect(photo);
        const embedding = new Float32Array(512);
        embedding[0] = Math.cos((degrees * Math.PI) / 180);
        embedding[1] = Math.sin((degrees * Math.PI) / 180);
        return [{ ...face!, embedding }];
      },
    });

    /** Three Photos, one Face each: A is like B, B is like C, A is not like C. */
    async function uploadChain() {
      const [a] = (await api.upload("crew.jpg", { detector: firstFaceAt(0) })).faces;
      const [b] = (await api.upload("crew-rotated.jpg", { detector: firstFaceAt(40) })).faces;
      const [c] = (await api.upload("armstrong-twice.jpg", { detector: firstFaceAt(80) })).faces;
      return { a: a!, b: b!, c: c! };
    }
    const reopen = async (fixtureName: string) => (await api.upload(fixtureName)).faces[0]!;

    it("is one Stranger", async () => {
      const { c } = await uploadChain();

      expect(c.stranger?.photoCount).toBe(3);
      expect((await reopen("crew.jpg")).stranger).toEqual(c.stranger);
    });

    it("naming one Face of a Stranger suggests that Person for the rest, even the unlike ones", async () => {
      const { a } = await uploadChain();

      const neil = await api.nameFace(a.id, "Neil");

      expect((await reopen("crew-rotated.jpg")).suggestion).toEqual(neil);
      expect((await reopen("armstrong-twice.jpg")).suggestion).toEqual(neil);
    });

    it("rejecting that Suggestion takes the Face out of the Stranger", async () => {
      const { a, c } = await uploadChain();
      const neil = await api.nameFace(a.id, "Neil");

      const afterRejecting = await api.rejectSuggestion(c.id, neil.id);

      // Still in the Stranger, it would show "in 2 Photos" (B and C); alone, it shows no label.
      expect(afterRejecting).toEqual({ id: c.id, box: c.box });
      expect(await reopen("armstrong-twice.jpg")).toEqual(afterRejecting);
      expect((await reopen("crew-rotated.jpg")).suggestion).toEqual(neil);
    });

    it("suggests the named Person for the rest even when another Person is a nearer match", async () => {
      const { a } = await uploadChain();
      const neil = await api.nameFace(a.id, "Neil");
      // Buzz is like C (cosine 0.55, enough for a Suggestion) but not enough to join its Stranger.
      const buzzAt80: FaceDetector = {
        modelVersion: faceDetector.modelVersion,
        detect: async (photo) => {
          const [face] = await faceDetector.detect(photo);
          const embedding = new Float32Array(512);
          embedding[0] = 0.55 * Math.cos((80 * Math.PI) / 180);
          embedding[1] = 0.55 * Math.sin((80 * Math.PI) / 180);
          embedding[2] = Math.sqrt(1 - 0.55 ** 2);
          return [{ ...face!, embedding }];
        },
      };
      const [buzzFace] = (await api.upload("person-and-dog.jpg", { detector: buzzAt80 })).faces;
      await api.nameFace(buzzFace!.id, "Buzz");

      expect((await reopen("armstrong-twice.jpg")).suggestion).toEqual(neil);
    });

    it("keeps one state per Face: naming or confirming takes it out of its Stranger", async () => {
      const { a, b } = await uploadChain();
      const neil = await api.nameFace(a.id, "Neil");
      await api.confirmSuggestion(b.id, neil.id);

      const stored = api.storedRows()["faces"]!;
      for (const named of [a, b]) {
        expect(stored.find((row) => row["id"] === named.id)).toMatchObject({ person_id: neil.id, stranger_id: null });
      }
      // C is still suggested as Neil.
      expect((await reopen("armstrong-twice.jpg")).suggestion).toEqual(neil);
    });
  });

  it("upgrades a faces.db that kept a named Face in its Stranger, and refuses both from then on", async () => {
    await api.close();
    const crewPhoto = await photoHash("crew.jpg");
    const twicePhoto = await photoHash("armstrong-twice.jpg");
    const unit = (axis: number) => {
      const embedding = new Float32Array(512);
      embedding[axis] = 1;
      return new Uint8Array(embedding.buffer);
    };
    api = await openApi({
      exiftool,
      faceDetector,
      // As the face store left it before a Face had one state: the named Face
      // kept its Stranger, which the unlike Face is also in.
      existing: (db) => {
        db.exec(`
          CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
          CREATE TABLE strangers (id INTEGER PRIMARY KEY AUTOINCREMENT);
          CREATE TABLE faces (
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
          CREATE TABLE photos (sha256 TEXT PRIMARY KEY, model_version TEXT NOT NULL);
          INSERT INTO people VALUES ('neil', 'Neil');
          INSERT INTO strangers VALUES (5);`);
        const insert = db.prepare("INSERT INTO faces VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, ?, ?, ?, 0, 5)");
        insert.run("named", crewPhoto, faceDetector.modelVersion, unit(0), "neil");
        insert.run("unnamed", twicePhoto, faceDetector.modelVersion, unit(1), null);
        const photo = db.prepare("INSERT INTO photos VALUES (?, ?)");
        for (const sha256 of [crewPhoto, twicePhoto]) photo.run(sha256, faceDetector.modelVersion);
      },
    });

    expect((await api.upload("armstrong-twice.jpg")).faces).toEqual([
      expect.objectContaining({ id: "unnamed", suggestion: { id: "neil", name: "Neil" } }),
    ]);
    expect((await api.upload("crew.jpg")).faces).toEqual([
      expect.objectContaining({ id: "named", person: { id: "neil", name: "Neil" } }),
    ]);
    expect(api.storedRows()["faces"]!.find((row) => row["id"] === "named")).toMatchObject({ stranger_id: null });
    const db = new DatabaseSync(api.dbPath);
    try {
      expect(() => db.exec("UPDATE faces SET stranger_id = (SELECT id FROM strangers) WHERE id = 'named'")).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  });

  it("a Stranger left with Faces in one Photo shows no label", async () => {
    const [, collins] = (await api.upload("crew.jpg")).faces;
    await api.upload("crew-rotated.jpg");

    await api.markNotAFace(collins!.id);

    expect(strangerLabels((await api.upload("crew-rotated.jpg")).faces)).toEqual([
      expect.stringMatching(/, in 2 Photos$/),
      undefined,
      expect.stringMatching(/, in 2 Photos$/),
    ]);
  });
});

/** The SHA-256 of a fixture's bytes: the Photo's hash, as the store keys it. */
const photoHash = async (name: string) => createHash("sha256").update(await readFile(fixture(name))).digest("hex");

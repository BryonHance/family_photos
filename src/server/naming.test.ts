import { readdir } from "node:fs/promises";
import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
// crew.jpg shows three Faces, left to right: Armstrong, Collins, Aldrin.

let exiftool: ExifTool;
let faceDetector: FaceDetector;
let api: FaceApi;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadFaceDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
});

beforeEach(async () => {
  api = await openFaceApi({ exiftool, faceDetector });
});

afterEach(async () => {
  await api.close();
});

describe("reopening a Photo", () => {
  it("returns the same stored Faces, without storing them twice", async () => {
    const first = await api.upload("crew.jpg");
    const second = await api.upload("crew.jpg");

    expect(first.faces).toHaveLength(3);
    expect(first.faces.every((face) => typeof face.id === "string")).toBe(true);
    expect(second.faces).toEqual(first.faces);
    expect(api.storedRows()["faces"]).toHaveLength(3);
  });
});

describe("naming a Face", () => {
  it("keeps the name for the next time the Photo is opened", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;

    const person = await api.nameFace(armstrong!.id, "Neil Armstrong");

    expect(person.name).toBe("Neil Armstrong");
    const reopened = await api.upload("crew.jpg");
    expect(reopened.faces.map((face) => face.person?.name)).toEqual(["Neil Armstrong", undefined, undefined]);
    expect(reopened.faces[0]!.person).toEqual(person);
  });

  it("reuses the Person of an existing name, ignoring case and spaces around it", async () => {
    const [armstrong, , aldrin] = (await api.upload("crew.jpg")).faces;
    const first = await api.nameFace(armstrong!.id, "Neil");

    const second = await api.nameFace(aldrin!.id, "  neil ");

    expect(second).toEqual(first);
    expect(await api.people()).toEqual([{ id: first.id, name: "Neil", faceCount: 2 }]);
  });

  it("renames a Face to another Person", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(armstrong!.id, "Buzz");

    await api.nameFace(armstrong!.id, "Neil");

    expect((await api.upload("crew.jpg")).faces[0]!.person?.name).toBe("Neil");
    expect((await api.people()).map((p) => [p.name, p.faceCount])).toEqual([
      ["Buzz", 0],
      ["Neil", 1],
    ]);
  });

  it("refuses an empty name and an unknown Face", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;

    expect((await api.call("PUT", `/api/faces/${armstrong!.id}/person`, { name: "  " })).status).toBe(400);
    expect((await api.call("PUT", "/api/faces/no-such-face/person", { name: "Neil" })).status).toBe(404);
    expect(await api.people()).toEqual([]);
  });
});

describe("People", () => {
  async function nameCrew(armstrong: string, collins: string, aldrin: string) {
    const faces = (await api.upload("crew.jpg")).faces;
    return {
      armstrong: await api.nameFace(faces[0]!.id, armstrong),
      collins: await api.nameFace(faces[1]!.id, collins),
      aldrin: await api.nameFace(faces[2]!.id, aldrin),
    };
  }
  const reopenedNames = async () => (await api.upload("crew.jpg")).faces.map((face) => face.person?.name);

  it("lists each Person by name with their Face count", async () => {
    await nameCrew("Neil", "Mike", "Neil");

    expect((await api.people()).map(({ name, faceCount }) => ({ name, faceCount }))).toEqual([
      { name: "Mike", faceCount: 1 },
      { name: "Neil", faceCount: 2 },
    ]);
  });

  it("renames a Person, which renames their Faces", async () => {
    const { armstrong } = await nameCrew("Neil", "Mike", "Buzz");

    expect(await api.renamePerson(armstrong.id, "Neil Armstrong")).toEqual({ id: armstrong.id, name: "Neil Armstrong" });

    expect(await reopenedNames()).toEqual(["Neil Armstrong", "Mike", "Buzz"]);
  });

  it("refuses to rename a Person to another Person's name, or to nothing", async () => {
    const { armstrong } = await nameCrew("Neil", "Mike", "Buzz");

    expect((await api.call("PATCH", `/api/people/${armstrong.id}`, { name: "buzz" })).status).toBe(409);
    expect((await api.call("PATCH", `/api/people/${armstrong.id}`, { name: "" })).status).toBe(400);
    expect((await api.call("PATCH", "/api/people/no-such-person", { name: "Neil" })).status).toBe(404);
    expect(await reopenedNames()).toEqual(["Neil", "Mike", "Buzz"]);
  });

  it("merges one Person into another, moving their Faces", async () => {
    const { armstrong, aldrin } = await nameCrew("Sam", "Mike", "Sam (baby)");

    await api.mergePeople(aldrin.id, armstrong.id);

    expect(await reopenedNames()).toEqual(["Sam", "Mike", "Sam"]);
    expect((await api.people()).map(({ name, faceCount }) => [name, faceCount])).toEqual([
      ["Mike", 1],
      ["Sam", 2],
    ]);
  });

  it("refuses to merge a Person into themselves or someone unknown", async () => {
    const { armstrong } = await nameCrew("Neil", "Mike", "Buzz");

    expect((await api.call("POST", `/api/people/${armstrong.id}/merge`, { into: armstrong.id })).status).toBe(400);
    expect((await api.call("POST", `/api/people/${armstrong.id}/merge`, { into: "nobody" })).status).toBe(404);
    expect(await api.people()).toHaveLength(3);
  });

  it("deletes a Person, leaving their Faces unnamed", async () => {
    const { collins } = await nameCrew("Neil", "Mike", "Buzz");

    await api.deletePerson(collins.id);

    expect(await reopenedNames()).toEqual(["Neil", undefined, "Buzz"]);
    expect((await api.people()).map((p) => p.name)).toEqual(["Buzz", "Neil"]);
    expect((await api.call("DELETE", `/api/people/${collins.id}`)).status).toBe(404);
  });

  it('"Delete all face data" leaves faces.db empty', async () => {
    const faces = (await api.upload("crew.jpg")).faces;
    await api.nameFace(faces[0]!.id, "Neil");
    await api.markNotAFace(faces[1]!.id);
    await api.rejectSuggestion(faces[2]!.id, (await api.nameFace(faces[2]!.id, "Buzz")).id);

    await api.deleteAllFaceData();

    const tables = api.storedRows();
    expect(Object.keys(tables)).toEqual(expect.arrayContaining(["people", "faces", "rejected_suggestions"]));
    for (const [table, rows] of Object.entries(tables)) expect(rows, table).toEqual([]);
    expect(await api.people()).toEqual([]);
  });
});

describe("a Photo stored under an older model version", () => {
  /** The real models standing in for an older version whose boxes sit `shift` box-widths to the right. */
  const olderModel = (shift: number): FaceDetector => ({
    modelVersion: "older-model",
    detect: async (photo) =>
      (await faceDetector.detect(photo)).map((face) => ({
        ...face,
        box: { ...face.box, x: face.box.x + shift * face.box.width },
      })),
  });

  it("is detected again, and each new Face keeps the Person or mark of the old box it mostly overlaps", async () => {
    const old = (await api.upload("crew.jpg", { detector: olderModel(0.15) })).faces;
    await api.nameFace(old[0]!.id, "Neil");
    await api.markNotAFace(old[1]!.id);

    const reopened = (await api.upload("crew.jpg")).faces;

    expect(reopened).toHaveLength(2);
    expect(reopened.map((face) => face.person?.name)).toEqual(["Neil", undefined]);
    expect(reopened.map((face) => face.id)).not.toContain(old[0]!.id);
    expect(reopened[0]!.box.x).toBeLessThan(old[0]!.box.x);
    // The old Faces are replaced, not kept beside the new ones.
    const rows = api.storedRows()["faces"]!;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row["model_version"]).filter((v) => v !== null)).toEqual([
      faceDetector.modelVersion,
      faceDetector.modelVersion,
    ]);
    expect(await api.upload("crew.jpg")).toMatchObject({ faces: reopened });
  });

  it("leaves a new Face unnamed when no old box mostly overlaps it", async () => {
    const old = (await api.upload("crew.jpg", { detector: olderModel(0.8) })).faces;
    await api.nameFace(old[0]!.id, "Neil");

    const reopened = (await api.upload("crew.jpg")).faces;

    expect(reopened.map((face) => face.person)).toEqual([undefined, undefined, undefined]);
  });
});

describe("what is kept (ADR-0001, ADR-0002)", () => {
  it("keeps neither the Photo nor any image of a Face, only embeddings, boxes and the Photo's hash", async () => {
    const faces = (await api.upload("crew.jpg")).faces;
    await api.nameFace(faces[0]!.id, "Neil");
    await api.upload("crew-oriented.heic");

    expect(await readdir(api.tempDir)).toEqual([]);
    const rows = api.storedRows()["faces"]!;
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["box_height", "box_width", "box_x", "box_y", "embedding", "id", "model_version", "not_a_face", "person_id", "photo_sha256"],
      );
      // 512 float32s: an embedding, not pixels.
      expect((row["embedding"] as Uint8Array).byteLength).toBe(512 * 4);
    }
  });
});

describe('"Not a face"', () => {
  it("hides the Face on reopening and keeps only its box and the Photo hash", async () => {
    const [armstrong, collins, aldrin] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(collins!.id, "Michael Collins");

    await api.markNotAFace(collins!.id);

    expect((await api.upload("crew.jpg")).faces.map((face) => face.id)).toEqual([armstrong!.id, aldrin!.id]);
    const rows = api.storedRows()["faces"]!;
    expect(rows).toHaveLength(3);
    const dismissed = rows.find((row) => row["id"] === collins!.id)!;
    expect(dismissed["embedding"]).toBeNull();
    expect(dismissed["person_id"]).toBeNull();
    expect(dismissed["photo_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await api.people()).toEqual([expect.objectContaining({ name: "Michael Collins", faceCount: 0 })]);
  });

  it("cannot then be named", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.markNotAFace(armstrong!.id);

    expect((await api.call("PUT", `/api/faces/${armstrong!.id}/person`, { name: "Neil" })).status).toBe(404);
    expect((await api.call("POST", "/api/faces/no-such-face/not-a-face")).status).toBe(404);
  });
});

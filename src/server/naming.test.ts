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

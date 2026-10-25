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

import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
// crew.jpg shows three Faces, left to right: Armstrong, Collins, Aldrin.
// crew-rotated.jpg is another Photo (other bytes) of the same three, upright the same.
// armstrong-twice.jpg shows Armstrong twice: cropped from crew.jpg, then beside it mirrored.

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

const suggestedNames = (faces: { suggestion?: { name: string } }[]) => faces.map((face) => face.suggestion?.name);

describe("Suggestions", () => {
  it("suggests the Person of a named Face for the same Face in another Photo", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");

    const faces = (await api.upload("crew-rotated.jpg")).faces;

    expect(faces[0]!.suggestion).toEqual(neil);
    expect(faces[0]!.person).toBeUndefined();
    expect(suggestedNames(faces)).toEqual(["Neil", undefined, undefined]);
  });
});

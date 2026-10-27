import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc, D-FINE-S and Avito models: fetch them with `pixi run models`.
// The same cat is in cat.jpg, cat.png, cat.webp and (left) cat-and-dog.jpg.
// The same dog is in dog.jpg, person-and-dog.jpg and (right) cat-and-dog.jpg.

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

const suggestedNames = (animals: { suggestion?: { name: string } }[]) => animals.map((animal) => animal.suggestion?.name);

describe("Suggestions", () => {
  it("suggests the Pet of a named Animal for the same pet in another Photo", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");

    const animals = (await api.upload("cat-and-dog.jpg")).animals;

    expect(animals[0]!.suggestion).toEqual(tom);
    expect(animals[0]!.pet).toBeUndefined();
    expect(suggestedNames(animals)).toEqual(["Tom", undefined]);
  });
});

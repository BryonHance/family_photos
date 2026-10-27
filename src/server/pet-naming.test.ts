import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc, D-FINE-S and Avito models: fetch them with `pixi run models`.
// cat-and-dog.jpg shows two Animals, left to right: a cat and a dog. cat.jpg shows the same cat alone.
// person-and-dog.jpg shows one Face and one Animal.

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

describe("naming an Animal", () => {
  it("creates a Pet, and naming another Animal with the same name reuses it", async () => {
    const [cat, dog] = (await api.upload("cat-and-dog.jpg")).animals;

    const tom = await api.nameAnimal(cat!.id, "Tom");
    const again = await api.nameAnimal(dog!.id, "  tom ");

    expect(tom.name).toBe("Tom");
    expect(again).toEqual(tom);
    expect(await api.pets()).toEqual([{ id: tom.id, name: "Tom", animalCount: 2 }]);
  });
});

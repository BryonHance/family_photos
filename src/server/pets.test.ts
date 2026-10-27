import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis, Box } from "../shared/analysis.ts";
import { createApp } from "./app.ts";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { openFaceStore } from "./faces/store.ts";
import { loadAnimalDetector, type AnimalDetector } from "./pets/detector.ts";

// These tests run the real buffalo_sc and D-FINE-S models: fetch them with `pixi run models`.
const modelsDir = join(import.meta.dirname, "../../models");
const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;
let faceDetector: FaceDetector;
let animalDetector: AnimalDetector;

beforeAll(async () => {
  exiftool = new ExifTool();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
  faceDetector = await loadFaceDetector(modelsDir);
  animalDetector = await loadAnimalDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
  await rm(tempDir, { recursive: true, force: true });
});

async function analyze(fixtureName: string): Promise<Analysis> {
  const app = createApp({
    exiftool,
    tempDir,
    faceDetector,
    faceStore: openFaceStore(":memory:"),
    animalDetector,
    maxUploadBytes: 1024 * 1024,
  });
  const form = new FormData();
  form.append("photo", new File([await readFile(fixture(fixtureName))], fixtureName));
  const res = await app.request("/api/analyze", { method: "POST", body: form });
  expect(res.status).toBe(200);
  return (await res.json()) as Analysis;
}

/** A point in fractions of the upright Photo, measured by eye. */
type Point = { what: string; x: number; y: number };

/** The box takes in every point, and is not simply the whole Photo. */
function expectBoxAround(box: Box, points: Point[]) {
  for (const { what, x, y } of points) {
    expect(x, `${what} x`).toBeGreaterThan(box.x);
    expect(x, `${what} x`).toBeLessThan(box.x + box.width);
    expect(y, `${what} y`).toBeGreaterThan(box.y);
    expect(y, `${what} y`).toBeLessThan(box.y + box.height);
  }
  expect(box.width * box.height).toBeLessThan(0.8);
}

// Where the animals are in the upright fixtures, by eye. The cat sits on a
// branch with its head to the left; the dog sits to the right of its handler.
const CAT = [
  { what: "cat's face", x: 0.39, y: 0.26 },
  { what: "cat's back", x: 0.62, y: 0.4 },
];
const DOG_IN_CROP = [
  { what: "dog's face", x: 0.25, y: 0.42 },
  { what: "dog's chest", x: 0.3, y: 0.7 },
];

function expectOneCat(analysis: Analysis) {
  expect(analysis.animals).toEqual([{ species: "cat", box: expect.any(Object) }]);
  expectBoxAround(analysis.animals[0]!.box, CAT);
}

describe("Animals", () => {
  it("boxes a cat in a JPEG, with its species and box only", async () => {
    expectOneCat(await analyze("cat.jpg"));
  });

  it("boxes a dog in a JPEG", async () => {
    const { animals } = await analyze("dog.jpg");

    expect(animals).toEqual([{ species: "dog", box: expect.any(Object) }]);
    expectBoxAround(animals[0]!.box, DOG_IN_CROP);
  });

  it("boxes two animals in one Photo, ordered left to right", async () => {
    // cat-and-dog.jpg is the cat (left) beside the dog (right).
    const { animals } = await analyze("cat-and-dog.jpg");

    expect(animals.map((animal) => animal.species)).toEqual(["cat", "dog"]);
    expectBoxAround(animals[0]!.box, [{ what: "cat's face", x: 0.28, y: 0.26 }]);
    expectBoxAround(animals[1]!.box, [{ what: "dog's face", x: 0.8, y: 0.42 }]);
  });

  it("returns both the Faces and the Animals of a Photo with a person and a pet", async () => {
    const { faces, animals } = await analyze("person-and-dog.jpg");

    expect(faces).toHaveLength(1);
    expectBoxAround(faces[0]!.box, [{ what: "soldier's face", x: 0.38, y: 0.32 }]);
    expect(animals.map((animal) => animal.species)).toEqual(["dog"]);
    expectBoxAround(animals[0]!.box, [{ what: "dog's face", x: 0.68, y: 0.4 }]);
  });

  it("returns no Animals for a Photo without cats or dogs", async () => {
    expect((await analyze("crew.jpg")).animals).toEqual([]);
    expect((await analyze("no-faces.jpg")).animals).toEqual([]);
  });

  it.each(["cat.png", "cat.webp"])("boxes the cat in %s, as in a JPEG", async (name) => {
    expectOneCat(await analyze(name));
  });

  it("boxes the cat of an EXIF-oriented HEIC on the upright Photo", async () => {
    // cat-oriented.heic is stored sideways with EXIF Orientation 6 and no irot box.
    const analysis = await analyze("cat-oriented.heic");
    expect(analysis.photo.mimeType).toBe("image/heic");
    expectOneCat(analysis);
  });

  it.each([
    ["cat.tif", "image/tiff"],
    ["cat.dng", "image/x-adobe-dng"],
  ])("returns no Animals for %s, even one that shows a cat", async (name, mimeType) => {
    const analysis = await analyze(name);
    expect(analysis.photo.mimeType).toBe(mimeType);
    expect(analysis.animals).toEqual([]);
  });
});

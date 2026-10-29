import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis } from "../shared/analysis.ts";
import { createApp } from "./app.ts";
import type { FaceDetector } from "./faces/detector.ts";
import { cosine } from "./recognition/similarity.ts";
import { openFaceStore } from "./faces/store.ts";
import type { AnimalDetector } from "./pets/detector.ts";
import { loadTestAnimalDetector, loadTestFaceDetector } from "./testing/models.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;
let faceDetector: FaceDetector;
let animalDetector: AnimalDetector;

beforeAll(async () => {
  exiftool = new ExifTool();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
  faceDetector = await loadTestFaceDetector();
  animalDetector = await loadTestAnimalDetector();
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

/**
 * Where each crew member's Face is in the upright Apollo 11 portrait, measured
 * by eye as the centre of the Face, in fractions of the Photo's width and
 * height. Collins stands between and above the others.
 */
const CREW_FACE_CENTRES = [
  { who: "Armstrong", x: 0.246, y: 0.405 },
  { who: "Collins", x: 0.484, y: 0.223 },
  { who: "Aldrin", x: 0.731, y: 0.416 },
];

function expectCrewFaces(analysis: Analysis) {
  expect(analysis.faces).toHaveLength(3);
  analysis.faces.forEach(({ box }, i) => {
    const expected = CREW_FACE_CENTRES[i]!;
    expect(box.x + box.width / 2, `${expected.who} x`).toBeCloseTo(expected.x, 1);
    expect(box.y + box.height / 2, `${expected.who} y`).toBeCloseTo(expected.y, 1);
    // A Face is a small part of a group portrait, not the whole Photo.
    expect(box.width).toBeGreaterThan(0.05);
    expect(box.width).toBeLessThan(0.2);
    expect(box.height).toBeGreaterThan(0.05);
    expect(box.height).toBeLessThan(0.25);
  });
}

describe("Faces", () => {
  it("boxes each Face in a JPEG, in fractions of the Photo, ordered left to right", async () => {
    expectCrewFaces(await analyze("crew.jpg"));
  });

  it("returns no Faces for a Photo without any", async () => {
    expect((await analyze("no-faces.jpg")).faces).toEqual([]);
  });

  it("boxes the Faces of an EXIF-rotated JPEG on the upright Photo", async () => {
    // crew-rotated.jpg is stored sideways with EXIF Orientation 6.
    expectCrewFaces(await analyze("crew-rotated.jpg"));
  });

  it("boxes the Faces of an EXIF-oriented HEIC on the upright Photo", async () => {
    // crew-oriented.heic is stored sideways with EXIF Orientation 6 and no irot box.
    const analysis = await analyze("crew-oriented.heic");
    expect(analysis.photo.mimeType).toBe("image/heic");
    expectCrewFaces(analysis);
  });

  it("returns no Faces for a TIFF, even one that shows some", async () => {
    const analysis = await analyze("crew.tif");
    expect(analysis.photo.mimeType).toBe("image/tiff");
    expect(analysis.faces).toEqual([]);
  });
});

describe("Face embeddings", () => {
  const detectFixture = async (name: string) =>
    faceDetector.detect({ kind: "encoded", bytes: await readFile(fixture(name)) });

  it("gives each Face a unit-length 512-number embedding", async () => {
    const faces = await detectFixture("crew.jpg");

    expect(faces).toHaveLength(3);
    for (const { embedding } of faces) {
      expect(embedding).toHaveLength(512);
      expect(cosine(embedding, embedding)).toBeCloseTo(1, 4);
    }
  });

  it("gives the same Face in two Photos near-identical embeddings, and different Faces distant ones", async () => {
    // crew-rotated.jpg is the same portrait stored sideways: the same three Faces.
    const upright = await detectFixture("crew.jpg");
    const rotated = await detectFixture("crew-rotated.jpg");

    upright.forEach((face, i) => {
      expect(cosine(face.embedding, rotated[i]!.embedding), `Face ${i + 1} in both`).toBeGreaterThan(0.9);
      upright.forEach((other, j) => {
        if (i !== j) expect(cosine(face.embedding, other.embedding), `Faces ${i + 1} and ${j + 1}`).toBeLessThan(0.4);
      });
    });
  });

  it("keeps the landmarks of a Face cut by the Photo's edge where they are, outside it, and only the box inside", async () => {
    // crew.jpg with its left 200 px cut off: the left edge runs through Armstrong's left eye.
    const cut = await sharp(await readFile(fixture("crew.jpg"))).extract({ left: 200, top: 0, width: 600, height: 629 }).toBuffer();

    const [armstrong] = await faceDetector.detect({ kind: "encoded", bytes: cut });

    expect(armstrong!.box.x).toBeGreaterThanOrEqual(0);
    expect(armstrong!.landmarks[0].x).toBeLessThan(0);
  });
});

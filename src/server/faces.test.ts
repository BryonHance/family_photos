import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis } from "../shared/analysis.ts";
import { createApp } from "./app.ts";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
const modelsDir = join(import.meta.dirname, "../../models");
const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;
let faceDetector: FaceDetector;

beforeAll(async () => {
  exiftool = new ExifTool();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
  faceDetector = await loadFaceDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
  await rm(tempDir, { recursive: true, force: true });
});

async function analyze(fixtureName: string): Promise<Analysis> {
  const app = createApp({ exiftool, tempDir, faceDetector, maxUploadBytes: 1024 * 1024 });
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

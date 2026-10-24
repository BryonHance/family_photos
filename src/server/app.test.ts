import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis, Section } from "../shared/analysis.ts";
import { createApp } from "./app.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;

beforeAll(async () => {
  exiftool = new ExifTool();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
});

afterAll(async () => {
  await exiftool.end();
  await rm(tempDir, { recursive: true, force: true });
});

async function post(fixtureName: string) {
  const app = createApp({ exiftool, tempDir });
  const form = new FormData();
  const bytes = await readFile(fixture(fixtureName));
  form.append("photo", new File([bytes], fixtureName, { type: "image/jpeg" }));
  form.append("lastModified", String(Date.UTC(2024, 6, 4)));
  return app.request("/api/analyze", { method: "POST", body: form });
}

async function analyze(fixtureName: string) {
  const res = await post(fixtureName);
  expect(res.status).toBe(200);
  return (await res.json()) as Analysis;
}

const section = (analysis: Analysis, name: Section["name"]) =>
  analysis.sections.find((s) => s.name === name);

describe("POST /api/analyze", () => {
  it("returns a JPEG's EXIF Fields with labels, Raw values and Display values", async () => {
    const exif = section(await analyze("full-exif.jpg"), "EXIF");
    expect(exif?.fields).toContainEqual({
      tag: "ExposureTime",
      label: "Exposure Time",
      raw: 0.004,
      display: "1/250",
    });
  });

  it("omits the Display value when it matches the Raw value", async () => {
    const analysis = await analyze("full-exif.jpg");

    const exif = section(analysis, "EXIF");
    expect(exif?.fields).toContainEqual({ tag: "Make", label: "Make", raw: "Canon" });
    expect(exif?.fields).toContainEqual({ tag: "FNumber", label: "F Number", raw: 4 });
  });

  it("describes the uploaded file in the File Section, not the server's temporary copy", async () => {
    const analysis = await analyze("full-exif.jpg");

    const file = section(analysis, "File");
    expect(file?.fields.slice(0, 2)).toEqual([
      { tag: "FileName", label: "File Name", raw: "full-exif.jpg" },
      { tag: "FileSize", label: "File Size", raw: 1000, display: "1000 bytes" },
    ]);
    expect(file?.fields).toContainEqual({ tag: "MIMEType", label: "MIME Type", raw: "image/jpeg" });
    expect(file?.fields).toContainEqual({ tag: "ImageWidth", label: "Image Width", raw: 64 });
    expect(file?.fields.map((f) => f.tag)).not.toContain("Directory");
    expect(file?.fields.map((f) => f.tag)).not.toContain("FilePermissions");
  });

  it("keeps no copy of the Photo once it has responded", async () => {
    await analyze("full-exif.jpg");

    expect(await readdir(tempDir)).toEqual([]);
  });

  it("tells the browser to preview a JPEG from its own copy", async () => {
    const analysis = await analyze("full-exif.jpg");

    expect(analysis.preview).toEqual({ kind: "client" });
    expect(analysis.photo).toEqual({ name: "full-exif.jpg", sizeBytes: 1000, mimeType: "image/jpeg" });
  });

  it("converts an iPhone HEIC to an upright JPEG returned inline", async () => {
    const analysis = await analyze("iphone.heic");

    expect(analysis.photo.mimeType).toBe("image/heic");
    const preview = analysis.preview;
    if (preview.kind !== "converted") throw new Error(`expected a converted preview, got ${preview.kind}`);
    expect(preview.mimeType).toBe("image/jpeg");
    // The fixture is stored landscape, red over blue, and recorded as rotated
    // 90 degrees clockwise. Upright it is portrait with red on the right.
    const image = jpeg.decode(Buffer.from(preview.base64, "base64"));
    expect([image.width, image.height]).toEqual([48, 64]);
    const pixel = (x: number, y: number) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
    const [leftR, , leftB] = pixel(4, 32);
    const [rightR, , rightB] = pixel(43, 32);
    expect(leftB).toBeGreaterThan(200);
    expect(leftR).toBeLessThan(50);
    expect(rightR).toBeGreaterThan(200);
    expect(rightB).toBeLessThan(50);
  });

  it.each(["gradient.png", "gradient.webp"])("tells the browser to preview %s from its own copy", async (name) => {
    expect((await analyze(name)).preview).toEqual({ kind: "client" });
  });

  it.each([
    ["scan.tif", "Epson"],
    ["raw.dng", "Canon"],
  ])("returns %s's Sections with no preview", async (name, make) => {
    const analysis = await analyze(name);

    expect(analysis.preview).toEqual({ kind: "none" });
    expect(section(analysis, "EXIF")?.fields).toContainEqual({ tag: "Make", label: "Make", raw: make });
  });
});

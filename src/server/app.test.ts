import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
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

const testUploadLimit = 5_000;

function send(form: FormData, maxUploadBytes = testUploadLimit) {
  const app = createApp({ exiftool, tempDir, maxUploadBytes });
  return app.request("/api/analyze", { method: "POST", body: form });
}

async function post(fixtureName: string, maxUploadBytes?: number) {
  const form = new FormData();
  const bytes = await readFile(fixture(fixtureName));
  form.append("photo", new File([bytes], fixtureName, { type: "image/jpeg" }));
  form.append("lastModified", String(Date.UTC(2024, 6, 4)));
  return send(form, maxUploadBytes);
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
});

describe("POST /api/analyze rejections", () => {
  it("rejects a request with no Photo with 400", async () => {
    const form = new FormData();
    form.append("lastModified", String(Date.UTC(2024, 6, 4)));

    const res = await send(form);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { kind: "no-photo", message: "No Photo was sent. Choose a Photo to analyze." },
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("rejects a Photo over the upload limit with 413", async () => {
    const res = await post("full-exif.jpg", 500);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { kind: "too-large", message: "This file is too large. Photos must be 500 bytes or smaller." },
    });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("rejects a file that is not a supported Photo with 415", async () => {
    const res = await post("not-a-photo.pdf");

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: {
        kind: "unsupported-file",
        message: "This file is not a supported Photo (application/pdf). Open a JPEG, PNG, WebP, HEIC, TIFF or RAW Photo.",
      },
    });
    expect(await readdir(tempDir)).toEqual([]);
  });
});

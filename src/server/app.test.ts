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

async function post(fixtureName: string, lastModified = Date.UTC(2024, 6, 4)) {
  const app = createApp({ exiftool, tempDir });
  const form = new FormData();
  const bytes = await readFile(fixture(fixtureName));
  form.append("photo", new File([bytes], fixtureName, { type: "image/jpeg" }));
  form.append("lastModified", String(lastModified));
  return app.request("/api/analyze", { method: "POST", body: form });
}

async function analyze(fixtureName: string, lastModified?: number) {
  const res = await post(fixtureName, lastModified);
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

describe("Warnings", () => {
  const kinds = (analysis: Analysis) => analysis.warnings.map((w) => w.kind);

  it("warns of No metadata when a Photo has no EXIF, IPTC or XMP", async () => {
    const analysis = await analyze("no-metadata.jpg");

    expect(kinds(analysis)).toEqual(["no-metadata"]);
    expect(analysis.warnings[0]?.message).toMatch(/stripped/i);
  });

  it("warns of No Date taken when a Photo has metadata but no Date taken", async () => {
    const analysis = await analyze("no-date-taken.jpg");

    expect(kinds(analysis)).toEqual(["no-date-taken"]);
  });

  // full-exif.jpg was taken at 2024-07-04 18:30:00-07:00, which is 01:30 UTC on 5 July.
  const takenAt = Date.UTC(2024, 6, 5, 1, 30);
  const hours = (n: number) => n * 60 * 60 * 1000;

  it("returns no Warnings for a healthy Photo", async () => {
    expect((await analyze("full-exif.jpg", takenAt)).warnings).toEqual([]);
  });

  it("warns of a Date mismatch when the modified time is more than 24 hours from the Date taken", async () => {
    expect(kinds(await analyze("full-exif.jpg", takenAt + hours(25)))).toEqual(["date-mismatch"]);
    expect(kinds(await analyze("full-exif.jpg", takenAt - hours(25)))).toEqual(["date-mismatch"]);
  });

  it("does not warn of a Date mismatch within 24 hours of the Date taken", async () => {
    expect(kinds(await analyze("full-exif.jpg", takenAt + hours(23)))).toEqual([]);
    expect(kinds(await analyze("full-exif.jpg", takenAt - hours(23)))).toEqual([]);
  });

  it("warns of a Damaged file for a truncated JPEG and still returns the Sections it could read", async () => {
    const analysis = await analyze("truncated.jpg", takenAt);

    expect(kinds(analysis)).toEqual(["damaged-file"]);
    expect(section(analysis, "EXIF")?.fields).toContainEqual({ tag: "Make", label: "Make", raw: "Canon" });
    expect(section(analysis, "File")?.fields).toContainEqual({ tag: "MIMEType", label: "MIME Type", raw: "image/jpeg" });
  });

  it("skips the Date mismatch check when there is no Date taken", async () => {
    expect(kinds(await analyze("no-date-taken.jpg", Date.UTC(2001, 0, 1)))).toEqual(["no-date-taken"]);
  });
});

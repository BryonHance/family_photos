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

  it("groups every Field into the seven Sections, in a fixed order", async () => {
    const analysis = await analyze("every-section.jpg");

    expect(analysis.sections.map((s) => s.name)).toEqual([
      "File",
      "EXIF",
      "GPS",
      "IPTC",
      "XMP",
      "ICC",
      "Maker notes",
    ]);
  });

  it.each([
    ["GPS", { tag: "GPSLatitudeRef", label: "GPS Latitude Ref", raw: "N", display: "North" }],
    ["IPTC", { tag: "Caption-Abstract", label: "Caption-Abstract", raw: "Family at the beach" }],
    ["XMP", { tag: "Title", label: "Title", raw: "Beach day" }],
    ["ICC", { tag: "ProfileCopyright", label: "Profile Copyright", raw: "No copyright, use freely" }],
    ["Maker notes", { tag: "CanonModelID", label: "Canon Model ID", raw: 0x80000453, display: "EOS R6" }],
  ] as const)("fills the %s Section", async (name, field) => {
    const analysis = await analyze("every-section.jpg");

    expect(section(analysis, name)?.fields).toContainEqual(field);
  });

  it("puts container groups in the nearest Section", async () => {
    const analysis = await analyze("every-section.jpg");

    expect(section(analysis, "File")?.fields.map((f) => f.tag)).toContain("JFIFVersion");
    expect(section(analysis, "ICC")?.fields.map((f) => f.tag)).toContain("ProfileCMMType");
  });

  it("leaves out Composite tags, which ExifTool derives rather than reads", async () => {
    const analysis = await analyze("every-section.jpg");

    const tags = analysis.sections.flatMap((s) => s.fields.map((f) => f.tag));
    expect(tags).not.toContain("GPSPosition");
    expect(tags).not.toContain("ImageSize");
    expect(tags).not.toContain("Megapixels");
    expect(tags.filter((tag) => tag === "GPSLatitude")).toHaveLength(1);
  });
});

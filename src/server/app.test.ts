import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis, Section } from "../shared/analysis.ts";
import { createApp } from "./app.ts";
import type { FaceDetector } from "./faces/detector.ts";
import { openFaceStore } from "./faces/store.ts";
import type { AnimalDetector } from "./pets/detector.ts";
import { loadTestAnimalDetector, loadTestFaceDetector } from "./testing/models.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;
let faceDetector: FaceDetector;
let animalDetector: AnimalDetector;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadTestFaceDetector();
  animalDetector = await loadTestAnimalDetector();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
});

afterAll(async () => {
  await exiftool.end();
  await rm(tempDir, { recursive: true, force: true });
});

const testUploadLimit = 5_000;

function send(form: FormData, maxUploadBytes = testUploadLimit) {
  const app = createApp({
    exiftool,
    tempDir,
    faceDetector,
    faceStore: openFaceStore(":memory:"),
    animalDetector,
    maxUploadBytes,
  });
  return app.request("/api/analyze", { method: "POST", body: form });
}

async function post(
  fixtureName: string,
  { maxUploadBytes, lastModified = Date.UTC(2024, 6, 4) }: { maxUploadBytes?: number; lastModified?: number } = {},
) {
  const form = new FormData();
  const bytes = await readFile(fixture(fixtureName));
  form.append("photo", new File([bytes], fixtureName, { type: "image/jpeg" }));
  form.append("lastModified", String(lastModified));
  return send(form, maxUploadBytes);
}

async function analyze(fixtureName: string, lastModified?: number) {
  const res = await post(fixtureName, { lastModified });
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

  it("gives the file's modified time, as the browser sent it, in the File Section", async () => {
    const analysis = await analyze("full-exif.jpg", Date.UTC(2024, 6, 5, 1, 30));

    expect(section(analysis, "File")?.fields).toContainEqual({
      tag: "FileModifyDate",
      label: "File Modification Date/Time",
      raw: Date.UTC(2024, 6, 5, 1, 30),
      display: "2024:07:05 01:30:00+00:00",
    });
  });

  it.each([
    ["no modified time", undefined],
    ["a modified time that is not a number", "yesterday"],
    ["a modified time outside the range of dates", "1e20"],
  ])("leaves the file's modified time out of the File Section when the browser sent %s", async (_, lastModified) => {
    const form = new FormData();
    form.append("photo", new File([await readFile(fixture("full-exif.jpg"))], "full-exif.jpg", { type: "image/jpeg" }));
    if (lastModified !== undefined) form.append("lastModified", lastModified);

    const res = await send(form);

    expect(res.status).toBe(200);
    const analysis = (await res.json()) as Analysis;
    expect(section(analysis, "File")?.fields.map((f) => f.tag)).not.toContain("FileModifyDate");
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

  /**
   * The HEIC fixtures are stored landscape, red over blue, and recorded as rotated
   * 90 degrees clockwise. Upright they are portrait with red on the right.
   */
  function expectUprightRedOnTheRight(analysis: Analysis) {
    expect(analysis.photo.mimeType).toBe("image/heic");
    const preview = analysis.preview;
    if (preview.kind !== "converted") throw new Error(`expected a converted preview, got ${preview.kind}`);
    expect(preview.mimeType).toBe("image/jpeg");
    const decoded = jpeg.decode(Buffer.from(preview.base64, "base64"));
    expect([decoded.width, decoded.height]).toEqual([48, 64]);
    const pixel = (x: number, y: number) => [...decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3)];
    const [leftR, , leftB] = pixel(4, 32);
    const [rightR, , rightB] = pixel(43, 32);
    expect(leftB).toBeGreaterThan(200);
    expect(leftR).toBeLessThan(50);
    expect(rightR).toBeGreaterThan(200);
    expect(rightB).toBeLessThan(50);
  }

  it("converts an iPhone HEIC to an upright JPEG returned inline", async () => {
    // iphone.heic records the turn twice, in its irot box and its EXIF Orientation; it must be applied once.
    expectUprightRedOnTheRight(await analyze("iphone.heic"));
  });

  it("converts a HEIC whose only orientation is its EXIF Orientation to an upright JPEG", async () => {
    // exif-oriented.heic has EXIF Orientation 6 and no irot box.
    expectUprightRedOnTheRight(await analyze("exif-oriented.heic"));
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

  it("puts PNG text chunks in the XMP Section and the PNG image header in File", async () => {
    const analysis = await analyze("text-chunks.png");

    expect(section(analysis, "XMP")?.fields).toContainEqual({ tag: "Title", label: "Title", raw: "Beach day" });
    expect(section(analysis, "XMP")?.fields).toContainEqual({ tag: "Comment", label: "Comment", raw: "Family at the beach" });
    expect(section(analysis, "File")?.fields.map((f) => f.tag)).toContain("ColorType");
    expect(section(analysis, "File")?.fields.map((f) => f.tag)).not.toContain("Title");
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
    const res = await post("full-exif.jpg", { maxUploadBytes: 500 });

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

describe("Summary", () => {
  it("gives the full-EXIF Photo's Date taken, timezone, camera, lens, exposure and location", async () => {
    const { summary } = await analyze("full-exif.jpg");

    expect(summary).toEqual({
      dateTaken: "2024:07:04 18:30:00",
      timezone: "-07:00",
      camera: "Canon EOS R6",
      lens: "RF24-105mm F4 L IS USM",
      exposure: { shutter: "1/250", aperture: "f/4", iso: "200", focalLength: "50.0 mm" },
      location: { latitude: 37.7749, longitude: -122.4194 },
    });
  });

  it("omits location and timezone for a Photo without GPS Fields or a timezone offset", async () => {
    const { summary } = await analyze("no-location.jpg");

    expect(summary).toEqual({ dateTaken: "2023:12:25 09:15:00", camera: "Google Pixel 8" });
  });
});

describe("Warnings", () => {
  const kinds = (analysis: Analysis) => analysis.warnings.map((w) => w.kind);

  it("warns of No metadata when a Photo has no EXIF, IPTC or XMP", async () => {
    const analysis = await analyze("no-metadata.jpg");

    expect(kinds(analysis)).toEqual(["no-metadata"]);
    expect(analysis.warnings[0]?.message).toMatch(/stripped/i);
  });

  it("counts PNG text chunks as metadata, so a PNG with only text chunks has no No metadata Warning", async () => {
    expect(kinds(await analyze("text-chunks.png"))).toEqual(["no-date-taken"]);
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

  it("does not warn of a Damaged file for a minor ExifTool warning that says nothing about the file's structure", async () => {
    // minor-warning.jpg is healthy apart from unrecognized maker notes, a "[minor]" ExifTool warning.
    expect((await analyze("minor-warning.jpg", takenAt)).warnings).toEqual([]);
  });

  it("does not warn of a Damaged file for an ExifTool warning about one Field's text rather than the file's structure", async () => {
    // bad-text-encoding.jpg's UserComment has an unknown character code: "Invalid EXIF text encoding".
    expect((await analyze("bad-text-encoding.jpg", takenAt)).warnings).toEqual([]);
  });

  it("warns of a Damaged file for a truncated JPEG even when a minor ExifTool warning comes first", async () => {
    expect(kinds(await analyze("truncated-minor-warning.jpg", takenAt))).toEqual(["damaged-file"]);
  });

  it("warns of a Damaged file for a truncated JPEG even when a warning about one Field's text comes first", async () => {
    expect(kinds(await analyze("truncated-bad-text-encoding.jpg", takenAt))).toEqual(["damaged-file"]);
  });

  it("skips the Date mismatch check when there is no Date taken", async () => {
    expect(kinds(await analyze("no-date-taken.jpg", Date.UTC(2001, 0, 1)))).toEqual(["no-date-taken"]);
  });
});

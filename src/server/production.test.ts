import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Analysis } from "../shared/analysis.ts";
import { createProductionApp } from "./production.ts";

const fixture = (name: string) => join(import.meta.dirname, "../../fixtures", name);

let exiftool: ExifTool;
let tempDir: string;
let uiDir: string;

beforeAll(async () => {
  exiftool = new ExifTool();
  tempDir = await mkdtemp(join(tmpdir(), "family-photos-test-"));
  // Stands in for the built UI (`dist/web`), so the test does not depend on a build.
  uiDir = await mkdtemp(join(tmpdir(), "family-photos-ui-"));
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>Family Photos</title>");
  await mkdir(join(uiDir, "assets"));
  await writeFile(join(uiDir, "assets", "app.js"), "console.log('ui');");
});

afterAll(async () => {
  await exiftool.end();
  await rm(tempDir, { recursive: true, force: true });
  await rm(uiDir, { recursive: true, force: true });
});

const app = () => createProductionApp({ exiftool, tempDir, uiDir });

describe("production server", () => {
  it("serves the UI at the root", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Family Photos</title>");
  });

  it("serves the UI's built assets", async () => {
    const res = await app().request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('ui');");
  });

  it("serves the analyze API from the same origin as the UI", async () => {
    const form = new FormData();
    const bytes = await readFile(fixture("full-exif.jpg"));
    form.append("photo", new File([bytes], "full-exif.jpg", { type: "image/jpeg" }));

    const res = await app().request("/api/analyze", { method: "POST", body: form });

    expect(res.status).toBe(200);
    const analysis = (await res.json()) as Analysis;
    expect(analysis.photo.name).toBe("full-exif.jpg");
  });
});

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const modelsDir = join(import.meta.dirname, "../../models");
const main = join(import.meta.dirname, "main.ts");

let emptyModels: string;

beforeEach(async () => {
  emptyModels = await mkdtemp(join(tmpdir(), "family-photos-models-"));
});

afterEach(async () => {
  await rm(emptyModels, { recursive: true, force: true });
});

/** Starts the server as `node src/server/main.ts` does, and waits for it to exit. */
async function startServer(modelsDir: string) {
  try {
    await run(process.execPath, [main], {
      env: { ...process.env, MODELS_DIR: modelsDir, PORT: "0" },
      timeout: 10_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const { code, killed, stderr } = error as { code: number | null; killed: boolean; stderr: string };
    if (killed) throw new Error("The server kept running instead of refusing to start");
    return { code, stderr };
  }
}

describe("server startup", () => {
  it("refuses to start when a model file is missing, naming pixi run models", async () => {
    await copyFile(join(modelsDir, "w600k_mbf.onnx"), join(emptyModels, "w600k_mbf.onnx"));

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("det_500m.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when a model file is corrupt, naming pixi run models", async () => {
    await copyFile(join(modelsDir, "det_500m.onnx"), join(emptyModels, "det_500m.onnx"));
    await writeFile(join(emptyModels, "w600k_mbf.onnx"), "not a model");

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("w600k_mbf.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when the pet model is missing, naming pixi run models", async () => {
    await copyFaceModels();

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("dfine_s_coco.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when the pet model is corrupt, naming pixi run models", async () => {
    await copyFaceModels();
    await mkdir(join(emptyModels, "pets"));
    await writeFile(join(emptyModels, "pets", "dfine_s_coco.onnx"), "not a model");

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("dfine_s_coco.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when the Avito model is missing, naming pixi run models", async () => {
    await copyFaceModels();
    await copyPetDetector();

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("avito_clip_l.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when the Avito model has no recorded SHA-256, naming pixi run models", async () => {
    await copyFaceModels();
    await copyPetDetector();
    await writeFile(join(emptyModels, "pets", "avito_clip_l.onnx"), "not a model");

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("avito_clip_l.onnx");
    expect(stderr).toContain("pixi run models");
  });

  it("refuses to start when the Avito model does not match its recorded SHA-256, naming pixi run models", async () => {
    await copyFaceModels();
    await copyPetDetector();
    await writeFile(join(emptyModels, "pets", "avito_clip_l.onnx"), "not a model");
    // The SHA-256 of "the exported model", recorded beside it as the export does.
    await writeFile(
      join(emptyModels, "pets", "avito_clip_l.onnx.sha256"),
      "8f8a9f3e6c4c4e6c1a0f3e1e5d0c0d6e6b8a1b0d5f0b1e6a2c3d4e5f60718293  avito_clip_l.onnx\n",
    );

    const { code, stderr } = await startServer(emptyModels);

    expect(code).not.toBe(0);
    expect(stderr).toContain("avito_clip_l.onnx");
    expect(stderr).toContain("does not match");
    expect(stderr).toContain("pixi run models");
  });
});

/** Good face models, so that only the pet models are at fault. */
async function copyFaceModels() {
  for (const name of ["det_500m.onnx", "w600k_mbf.onnx"]) await copyFile(join(modelsDir, name), join(emptyModels, name));
}

/** A good D-FINE-S, so that only the Avito model is at fault. */
async function copyPetDetector() {
  await mkdir(join(emptyModels, "pets"));
  await copyFile(join(modelsDir, "pets", "dfine_s_coco.onnx"), join(emptyModels, "pets", "dfine_s_coco.onnx"));
}

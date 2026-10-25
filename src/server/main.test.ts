import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

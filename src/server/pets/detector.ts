import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ort from "onnxruntime-node";
import sharp from "sharp";
import type { Box, Species } from "../../shared/analysis.ts";
import type { Pixels } from "../pixels.ts";

export type DetectedAnimal = {
  species: Species;
  box: Box;
  /** D-FINE's confidence for the species, from 0.5 (the threshold) to 1. */
  score: number;
};

export type AnimalDetector = {
  /**
   * Names the pet models and the pipeline, apart from the face models' version:
   * Animals from different versions cannot be compared (ADR-0003).
   */
  modelVersion: string;
  /** The cats and dogs in the upright Photo, ordered left to right. */
  detect(image: Pixels<3>): Promise<DetectedAnimal[]>;
};

/** A pet model file is missing or does not match its pinned SHA-256. */
export class PetModelError extends Error {}

/** The pet models sit in their own directory beside the face models. */
const PET_MODELS_SUBDIR = "pets";
const DETECTOR_FILE = "dfine_s_coco.onnx";
/**
 * AvitoTech's CLIP-L vision tower, exported to ONNX by `scripts/export-avito.py`.
 * An export is not pinned like a download: its SHA-256 is recorded beside it.
 */
const EMBEDDING_FILE = "avito_clip_l.onnx";
/** Change it whenever the pet models or their pipeline change, so that stored Photos are detected again. */
export const PET_MODEL_VERSION = "dfine_s_coco-a3cf031";
const INPUT_SIZE = 640;
/** COCO classes among D-FINE's 80 logits. */
const SPECIES_BY_CLASS = new Map<number, Species>([
  [15, "cat"],
  [16, "dog"],
]);
const SCORE_THRESHOLD = 0.5;

/**
 * Checks every downloaded pet model file against its pinned SHA-256
 * (`models.sha256`, shared with `scripts/fetch-pet-models.sh`) and the exported
 * Avito model against the SHA-256 recorded beside it, then loads D-FINE-S to
 * run on the CPU. Throws a PetModelError naming `pixi run models` when a file is missing or corrupt.
 */
export async function loadAnimalDetector(modelsDir: string): Promise<AnimalDetector> {
  const petModelsDir = join(modelsDir, PET_MODELS_SUBDIR);
  await verifyModels(petModelsDir);
  const detector = await ort.InferenceSession.create(join(petModelsDir, DETECTOR_FILE), {
    executionProviders: ["cpu"],
    // Idle threads sleep instead of spinning, so that D-FINE does not starve
    // other work on the server (or other test files running beside it).
    extra: { session: { intra_op: { allow_spinning: "0" } } },
  });
  return {
    modelVersion: PET_MODEL_VERSION,
    detect: (image) => detect(detector, image),
  };
}

async function verifyModels(petModelsDir: string) {
  const list = await readFile(join(import.meta.dirname, "models.sha256"), "utf8");
  for (const line of list.split("\n").filter((l) => l.trim() !== "")) {
    const [expected, name] = line.trim().split(/\s+/) as [string, string];
    const path = join(petModelsDir, name);
    const actual = await sha256(path);
    if (actual === undefined) {
      throw new PetModelError(`Pet model ${path} is missing. Run \`pixi run models\` to download it.`);
    }
    if (actual !== expected) {
      throw new PetModelError(
        `Pet model ${path} does not match its pinned SHA-256. Run \`pixi run models\` to download it again.`,
      );
    }
  }

  const path = join(petModelsDir, EMBEDDING_FILE);
  // Recorded in sha256sum's format, so that `sha256sum --check` reads it too.
  const recorded = await readFile(`${path}.sha256`, "utf8").then(
    (text) => text.trim().split(/\s+/)[0],
    () => undefined,
  );
  const actual = recorded === undefined ? undefined : await sha256(path);
  if (actual === undefined) {
    throw new PetModelError(
      `Pet model ${path} or its recorded SHA-256 is missing. Run \`pixi run models\` to export it.`,
    );
  }
  if (actual !== recorded) {
    throw new PetModelError(
      `Pet model ${path} does not match its recorded SHA-256. Run \`pixi run models\` to export it again.`,
    );
  }
}

/** Hashes a file as a stream (the Avito model is 1.2 GB), or undefined if it is missing. */
async function sha256(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}

/**
 * D-FINE as onnx-community exported it: the Photo stretched to 640×640, RGB
 * scaled to 0–1 (no mean or std), NCHW. Its 300 queries each give 80 logits
 * (sigmoid, not softmax) and a box as centre and size in fractions of the
 * Photo, so the stretch needs no undoing. It needs no non-maximum suppression.
 */
async function detect(session: ort.InferenceSession, image: Pixels<3>): Promise<DetectedAnimal[]> {
  const stretched = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = stretched[i * 3 + c]! / 255;
  }
  const outputs = await session.run({
    [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  });
  const logits = outputs["logits"]!.data as Float32Array;
  const boxes = outputs["pred_boxes"]!.data as Float32Array;
  const queries = boxes.length / 4;
  const classes = logits.length / queries;

  const found: DetectedAnimal[] = [];
  for (let q = 0; q < queries; q++) {
    // Sigmoid scores are independent, so one query can pass as both a cat and a
    // dog. It is one Animal all the same: it takes the species it scores higher.
    let best: { species: Species; score: number } | undefined;
    for (const [index, species] of SPECIES_BY_CLASS) {
      const score = 1 / (1 + Math.exp(-logits[q * classes + index]!));
      if (score >= SCORE_THRESHOLD && score > (best?.score ?? 0)) best = { species, score };
    }
    if (!best) continue;
    const [cx, cy, w, h] = [boxes[q * 4]!, boxes[q * 4 + 1]!, boxes[q * 4 + 2]!, boxes[q * 4 + 3]!];
    const x = clamp(cx - w / 2);
    const y = clamp(cy - h / 2);
    const box = { x, y, width: clamp(cx + w / 2) - x, height: clamp(cy + h / 2) - y };
    if (box.width > 0 && box.height > 0) found.push({ ...best, box });
  }
  return found.sort((a, b) => a.box.x - b.box.x);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

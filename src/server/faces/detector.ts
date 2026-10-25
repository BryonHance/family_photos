import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ort from "onnxruntime-node";
import sharp from "sharp";
import type { Box } from "../../shared/analysis.ts";
import type { Pixels } from "../pixels.ts";
import { ALIGNED_SIZE, alignFace } from "./align.ts";
import { iou } from "./overlap.ts";

/** A point in fractions of the upright Photo's width and height. */
export type Point = { x: number; y: number };

export type DetectedFace = {
  box: Box;
  /** SCRFD's confidence, from 0.5 (the threshold) to 1. */
  score: number;
  /**
   * Eyes (left then right, as seen), nose tip, mouth corners (left then right): what alignment needs.
   * Unlike the box, they may lie outside the Photo when its edge cuts the Face.
   */
  landmarks: [Point, Point, Point, Point, Point];
  /** w600k_mbf's 512 numbers for the aligned Face, L2-normalised: compare by dot product (cosine). */
  embedding: Float32Array;
};

/**
 * The upright pixels of a Photo, as the face pipeline reads them: either an
 * encoded JPEG, PNG or WebP that sharp decodes and turns upright by its EXIF
 * Orientation, or raw pixels already upright (HEIC, decoded by heic-decode).
 */
export type PhotoPixels = { kind: "encoded"; bytes: Uint8Array } | ({ kind: "raw" } & Pixels);

export type FaceDetector = {
  /**
   * Names the models and the pipeline that made the embeddings. Embeddings from
   * different versions cannot be compared (ADR-0002).
   */
  modelVersion: string;
  /** The Faces in a Photo, ordered left to right, each with its embedding. */
  detect(photo: PhotoPixels): Promise<DetectedFace[]>;
};

/** A model file is missing or does not match its pinned SHA-256. */
export class FaceModelError extends Error {}

const DETECTOR_FILE = "det_500m.onnx";
const RECOGNIZER_FILE = "w600k_mbf.onnx";
/** Change it whenever the models or the alignment change, so that stored Photos are detected again. */
export const FACE_MODEL_VERSION = "buffalo_sc-v0.7/arcface-112";
/**
 * The upright Photo is decoded at most this size on its long side: enough
 * pixels to align a Face found at 640 px, without holding a 48 MP Photo in memory.
 */
const MAX_DECODED_SIDE = 2048;
const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const ANCHORS_PER_CELL = 2;
const SCORE_THRESHOLD = 0.5;
const NMS_IOU_THRESHOLD = 0.4;

/**
 * Checks every buffalo_sc model file against its pinned SHA-256
 * (`models.sha256`, shared with `scripts/fetch-models.sh`), then loads the
 * detector and the recognizer to run on the CPU. Throws a FaceModelError naming
 * `pixi run models` when a file is missing or corrupt.
 */
export async function loadFaceDetector(modelsDir: string): Promise<FaceDetector> {
  await verifyModels(modelsDir);
  const load = (file: string) => ort.InferenceSession.create(join(modelsDir, file), { executionProviders: ["cpu"] });
  const detector = await load(DETECTOR_FILE);
  const recognizer = await load(RECOGNIZER_FILE);
  return {
    modelVersion: FACE_MODEL_VERSION,
    async detect(photo) {
      const image = await decodeUpright(photo);
      // A Photo too damaged to decode has no Faces to find; its Warnings say why.
      if (!image) return [];
      const faces: DetectedFace[] = [];
      // One Face at a time: each aligned crop lives only in memory until it is embedded (ADR-0002).
      for (const face of await detect(detector, image)) {
        const pixels = face.landmarks.map((p) => ({ x: p.x * image.width, y: p.y * image.height }));
        faces.push({ ...face, embedding: await embed(recognizer, alignFace(image, pixels)) });
      }
      return faces;
    },
  };
}

async function verifyModels(modelsDir: string) {
  const list = await readFile(join(import.meta.dirname, "models.sha256"), "utf8");
  for (const line of list.split("\n").filter((l) => l.trim() !== "")) {
    const [expected, name] = line.trim().split(/\s+/) as [string, string];
    const path = join(modelsDir, name);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new FaceModelError(`Face model ${path} is missing. Run \`pixi run models\` to download it.`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new FaceModelError(
        `Face model ${path} does not match its pinned SHA-256. Run \`pixi run models\` to download it again.`,
      );
    }
  }
}

/**
 * The upright Photo as RGB, at most MAX_DECODED_SIDE on its long side.
 * Undefined when the Photo cannot be decoded at all; a Photo that is only
 * partly damaged is decoded as far as it goes.
 */
async function decodeUpright(photo: PhotoPixels): Promise<Pixels<3> | undefined> {
  const image =
    photo.kind === "encoded"
      ? sharp(photo.bytes, { failOn: "none" }).autoOrient()
      : sharp(photo.data, { raw: { width: photo.width, height: photo.height, channels: photo.channels } });
  try {
    const { data, info } = await image
      .resize(MAX_DECODED_SIDE, MAX_DECODED_SIDE, { fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: 3, data };
  } catch {
    return undefined;
  }
}

/** The Faces' boxes and landmarks, ordered left to right, before they are embedded. */
async function detect(session: ort.InferenceSession, image: Pixels<3>): Promise<Omit<DetectedFace, "embedding">[]> {
  const { tensor, scaledWidth, scaledHeight } = await letterbox(image);
  const outputs = await session.run({ [session.inputNames[0]!]: tensor });
  // Outputs must be looked up by name in outputNames order: scores for strides
  // 8/16/32, then boxes, then landmarks. The result object's own key order is not that.
  const output = (i: number) => outputs[session.outputNames[i]!]!.data as Float32Array;
  const candidates = STRIDES.flatMap((stride, i) =>
    decodeStride(stride, output(i), output(i + STRIDES.length), output(i + 2 * STRIDES.length)),
  );
  return nonMaximumSuppression(candidates)
    .map((face) => toFractions(face, scaledWidth, scaledHeight))
    .sort((a, b) => a.box.x - b.box.x);
}

/**
 * Shrinks (or enlarges) the upright Photo to 640 px on its long side and pastes it
 * at the top left of a black 640×640 square, as InsightFace does, normalised to
 * (x − 127.5) / 128 in RGB and laid out NCHW.
 */
async function letterbox(image: Pixels<3>) {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * plane).fill((0 - 127.5) / 128);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * info.channels;
      const d = y * INPUT_SIZE + x;
      input[d] = (data[s]! - 127.5) / 128;
      input[plane + d] = (data[s + 1]! - 127.5) / 128;
      input[2 * plane + d] = (data[s + 2]! - 127.5) / 128;
    }
  }
  return {
    tensor: new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    scaledWidth: info.width,
    scaledHeight: info.height,
  };
}

/** w600k_mbf on one aligned Face: (x − 127.5) / 127.5 in RGB, NCHW, then L2-normalised. */
async function embed(session: ort.InferenceSession, face: Pixels<3>): Promise<Float32Array> {
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (face.data[i * 3 + c]! - 127.5) / 127.5;
  }
  const outputs = await session.run({
    [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]),
  });
  const raw = outputs[session.outputNames[0]!]!.data as Float32Array;
  const length = Math.hypot(...raw);
  return Float32Array.from(raw, (v) => v / length);
}

type Candidate = { x1: number; y1: number; x2: number; y2: number; score: number; landmarks: number[] };

/**
 * SCRFD predicts, for each anchor, a score, distances from the anchor's centre to
 * the box's four sides, and offsets to five landmarks, all in units of the stride.
 * Anchors run row by row over a (640 / stride)² grid, two per cell.
 */
function decodeStride(stride: number, scores: Float32Array, boxes: Float32Array, landmarks: Float32Array): Candidate[] {
  const gridWidth = INPUT_SIZE / stride;
  const found: Candidate[] = [];
  for (let a = 0; a < scores.length; a++) {
    const score = scores[a]!;
    if (score < SCORE_THRESHOLD) continue;
    const cell = Math.floor(a / ANCHORS_PER_CELL);
    const cx = (cell % gridWidth) * stride;
    const cy = Math.floor(cell / gridWidth) * stride;
    const points: number[] = [];
    for (let p = 0; p < 5; p++) {
      points.push(cx + landmarks[a * 10 + p * 2]! * stride, cy + landmarks[a * 10 + p * 2 + 1]! * stride);
    }
    found.push({
      x1: cx - boxes[a * 4]! * stride,
      y1: cy - boxes[a * 4 + 1]! * stride,
      x2: cx + boxes[a * 4 + 2]! * stride,
      y2: cy + boxes[a * 4 + 3]! * stride,
      score,
      landmarks: points,
    });
  }
  return found;
}

function nonMaximumSuppression(candidates: Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((k) => iou(boxOf(k), boxOf(candidate)) <= NMS_IOU_THRESHOLD)) kept.push(candidate);
  }
  return kept;
}

const boxOf = (c: Candidate): Box => ({ x: c.x1, y: c.y1, width: c.x2 - c.x1, height: c.y2 - c.y1 });

/** From pixels of the scaled Photo in the letterbox to fractions of the upright Photo. */
function toFractions(c: Candidate, width: number, height: number): Omit<DetectedFace, "embedding"> {
  // Only the box is kept inside the Photo. Landmarks of a Face cut by its edge
  // stay where SCRFD put them, outside it, so that alignment is not distorted.
  const fx = (x: number) => x / width;
  const fy = (y: number) => y / height;
  const x = clamp(fx(c.x1));
  const y = clamp(fy(c.y1));
  const point = (i: number): Point => ({ x: fx(c.landmarks[i * 2]!), y: fy(c.landmarks[i * 2 + 1]!) });
  return {
    box: { x, y, width: clamp(fx(c.x2)) - x, height: clamp(fy(c.y2)) - y },
    score: c.score,
    landmarks: [point(0), point(1), point(2), point(3), point(4)],
  };
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

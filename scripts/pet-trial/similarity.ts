// The pet trial run: can D-FINE-S + DINOv2-S, or D-FINE-S + Avito CLIP-L, tell
// our pets apart? See docs/research/face-and-pet-recognition.md, open question 1.
//
//   pixi run pet-models                        # D-FINE-S and DINOv2-S
//   pixi run -e pet-export pet-export          # Avito CLIP-L (optional; 1.7 GB download)
//   pixi run pet-trial <sample-dir>
//
// <sample-dir> holds one folder per pet (any name), each holding Photos of that
// pet (JPEG, PNG, WebP or HEIC). The largest cat or dog D-FINE finds in each Photo
// is taken to be that pet, so prefer Photos where it is the only or the biggest
// animal. For each embedding it prints how alike same-pet and different-pet pairs
// are, how often a Photo's nearest neighbour is the same pet, and the CPU time per
// step. Crops live only in memory and nothing is stored or sent anywhere. Keep the
// sample itself off GitHub.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exiftool } from "exiftool-vendored";
import ort from "onnxruntime-node";
import sharp, { type Sharp } from "sharp";
import { cosine } from "../../src/server/faces/similarity.ts";
import type { Pixels } from "../../src/server/pixels.ts";
import { decodeUprightHeic } from "../../src/server/preview.ts";

const sampleDir = process.argv[2];
if (!sampleDir) {
  console.error("Usage: pixi run pet-trial <sample-dir>   (one folder per pet, holding Photos of them)");
  process.exit(2);
}
const modelsDir = process.env.PET_MODELS_DIR ?? join(import.meta.dirname, "../../models/pets");

/** COCO classes in D-FINE's 80 logits. */
const SPECIES = new Map([
  [15, "cat"],
  [16, "dog"],
]);
const DETECTION_THRESHOLD = 0.5;
const DETECTOR_SIZE = 640;
const EMBED_SIZE = 224;
const MAX_DECODED_SIDE = 2048;

type Embedder = { name: string; file: string; mean: number[]; std: number[]; read: (output: Float32Array) => Float32Array };
const EMBEDDERS: Embedder[] = [
  {
    name: "DINOv2-S",
    file: "dinov2_small.onnx",
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    // last_hidden_state: the class token comes first; it is the image's embedding.
    read: (output) => output.subarray(0, 384),
  },
  {
    name: "Avito CLIP-L",
    file: "avito_clip_l.onnx",
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.26130258, 0.27577711],
    read: (output) => output,
  },
];

const load = (file: string) => ort.InferenceSession.create(join(modelsDir, file), { executionProviders: ["cpu"] });
let detector: ort.InferenceSession;
try {
  detector = await load("dfine_s_coco.onnx");
} catch {
  console.error(`No D-FINE model in ${modelsDir}. Run \`pixi run pet-models\` first.`);
  process.exit(1);
}
const embedders: (Embedder & { session: ort.InferenceSession })[] = [];
for (const embedder of EMBEDDERS) {
  try {
    embedders.push({ ...embedder, session: await load(embedder.file) });
  } catch {
    console.log(`Skipping ${embedder.name}: no ${embedder.file} in ${modelsDir}.`);
  }
}

type Animal = { pet: number; photo: string; species: string; embeddings: Float32Array[] };
const animals: Animal[] = [];
const timings = { decode: [] as number[], detect: [] as number[], embed: embedders.map(() => [] as number[]) };
const missed: string[] = [];
const speciesCount = new Map<string, number>();
let photos = 0;

const folders = (await readdir(sampleDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
for (const [pet, folder] of folders.entries()) {
  for (const file of (await readdir(join(sampleDir, folder.name))).sort()) {
    if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(file)) continue;
    photos++;
    const path = join(sampleDir, folder.name, file);
    const label = `${folder.name}/${file}`;

    let started = performance.now();
    const image = await decodeUpright(path);
    timings.decode.push(performance.now() - started);
    if (!image) {
      missed.push(`${label} (could not decode)`);
      continue;
    }

    started = performance.now();
    const found = await detect(image);
    timings.detect.push(performance.now() - started);
    const largest = found.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!largest) {
      missed.push(label);
      continue;
    }
    speciesCount.set(largest.species, (speciesCount.get(largest.species) ?? 0) + 1);

    const embeddings: Float32Array[] = [];
    for (const [i, embedder] of embedders.entries()) {
      started = performance.now();
      embeddings.push(await embed(embedder, image, largest));
      timings.embed[i]!.push(performance.now() - started);
    }
    animals.push({ pet, photo: label, species: largest.species, embeddings });
  }
}
await exiftool.end();

const species = [...speciesCount].map(([name, count]) => `${count} ${name}`).join(", ") || "none";
console.log(`\n${folders.length} pets, ${photos} Photos, ${animals.length} with a pet found (${species}), ${missed.length} without`);
for (const label of missed.slice(0, 20)) console.log(`  no cat or dog found: ${label}`);
if (missed.length > 20) console.log(`  ... and ${missed.length - 20} more`);

console.log("\nCPU time, median per Photo (per pet for embeddings):");
console.log(`  decode         ${median(timings.decode)}`);
console.log(`  D-FINE-S       ${median(timings.detect)}`);
for (const [i, embedder] of embedders.entries()) console.log(`  ${embedder.name.padEnd(14)} ${median(timings.embed[i]!)}`);

for (const [m, embedder] of embedders.entries()) {
  console.log(`\n=== ${embedder.name} ===`);
  const same: number[] = [];
  const different: number[] = [];
  for (let i = 0; i < animals.length; i++) {
    for (let j = i + 1; j < animals.length; j++) {
      const a = animals[i]!;
      const b = animals[j]!;
      (a.pet === b.pet ? same : different).push(cosine(a.embeddings[m]!, b.embeddings[m]!));
    }
  }
  summarise("Same pet      ", same);
  summarise("Different pets", different);

  // A family confirms each Suggestion, so what matters most is whether the
  // closest Photo already seen shows the same pet.
  const wrong: string[] = [];
  for (const a of animals) {
    let best: Animal | undefined;
    let bestSimilarity = -Infinity;
    for (const b of animals) {
      if (b === a) continue;
      const similarity = cosine(a.embeddings[m]!, b.embeddings[m]!);
      if (similarity > bestSimilarity) [best, bestSimilarity] = [b, similarity];
    }
    if (best && best.pet !== a.pet) wrong.push(`${a.photo} -> ${best.photo} (${bestSimilarity.toFixed(3)})`);
  }
  if (animals.length > 1) {
    const right = animals.length - wrong.length;
    console.log(`Nearest neighbour is the same pet: ${right}/${animals.length} (${((100 * right) / animals.length).toFixed(1)}%)`);
    for (const line of wrong.slice(0, 20)) console.log(`  wrong: ${line}`);
    if (wrong.length > 20) console.log(`  ... and ${wrong.length - 20} more`);
  }

  console.log("threshold   same-pet pairs at or above   different-pet pairs at or above");
  for (let t = 0.3; t < 0.96; t += 0.05) {
    const share = (values: number[]) =>
      values.length === 0 ? "-" : `${((100 * values.filter((v) => v >= t).length) / values.length).toFixed(1)}%`;
    console.log(`${t.toFixed(2).padStart(9)}   ${share(same).padStart(26)}   ${share(different).padStart(31)}`);
  }
}

/**
 * The upright Photo as RGB, at most MAX_DECODED_SIDE on its long side. A HEIC is
 * turned upright as the viewer does, from the tags ExifTool reads.
 */
async function decodeUpright(path: string): Promise<Pixels<3> | undefined> {
  try {
    const bytes = await readFile(path);
    let image: Sharp;
    if (/\.hei[cf]$/i.test(path)) {
      const tags = (await exiftool.readRaw(path, { readArgs: ["-n", "-G0:1"] })) as Record<string, unknown>;
      const upright = await decodeUprightHeic(bytes, {
        exif: typeof tags["EXIF:IFD0:Orientation"] === "number" ? tags["EXIF:IFD0:Orientation"] : undefined,
        heifTransform: "QuickTime:Rotation" in tags || "QuickTime:Mirroring" in tags,
      });
      image = sharp(upright.data, { raw: { width: upright.width, height: upright.height, channels: 4 } });
    } else {
      image = sharp(bytes, { failOn: "none" }).autoOrient();
    }
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

/** A cat or dog, its box in pixels of the decoded Photo. */
type Found = { species: string; score: number; x: number; y: number; width: number; height: number };

/**
 * D-FINE as onnx-community exported it: the Photo stretched to 640×640, RGB
 * scaled to 0–1 (no mean or std), NCHW. Its 300 queries each give 80 logits
 * (sigmoid, not softmax) and a box as centre and size in fractions of the
 * Photo, so the stretch needs no undoing. It needs no non-maximum suppression.
 */
async function detect(image: Pixels<3>): Promise<Found[]> {
  const resized = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize(DETECTOR_SIZE, DETECTOR_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  const input = toTensor(resized, DETECTOR_SIZE, [0, 0, 0], [1, 1, 1]);
  const outputs = await detector.run({ pixel_values: input });
  const logits = outputs.logits!.data as Float32Array;
  const boxes = outputs.pred_boxes!.data as Float32Array;
  const classes = logits.length / (boxes.length / 4);
  const found: Found[] = [];
  for (let q = 0; q < boxes.length / 4; q++) {
    for (const [index, name] of SPECIES) {
      const score = 1 / (1 + Math.exp(-logits[q * classes + index]!));
      if (score < DETECTION_THRESHOLD) continue;
      const [cx, cy, w, h] = boxes.subarray(q * 4, q * 4 + 4) as unknown as [number, number, number, number];
      const x = Math.max(0, (cx - w / 2) * image.width);
      const y = Math.max(0, (cy - h / 2) * image.height);
      const width = Math.min(image.width, (cx + w / 2) * image.width) - x;
      const height = Math.min(image.height, (cy + h / 2) * image.height) - y;
      if (width >= 1 && height >= 1) found.push({ species: name, score, x, y, width, height });
    }
  }
  return found;
}

/** The pet's box, padded to a square with black and resized to 224, embedded and L2-normalised. */
async function embed(embedder: Embedder & { session: ort.InferenceSession }, image: Pixels<3>, box: Found) {
  const crop = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .extract({
      left: Math.floor(box.x),
      top: Math.floor(box.y),
      width: Math.min(image.width - Math.floor(box.x), Math.ceil(box.width)),
      height: Math.min(image.height - Math.floor(box.y), Math.ceil(box.height)),
    })
    .resize(EMBED_SIZE, EMBED_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer();
  const outputs = await embedder.session.run({ pixel_values: toTensor(crop, EMBED_SIZE, embedder.mean, embedder.std) });
  const raw = embedder.read(outputs[embedder.session.outputNames[0]!]!.data as Float32Array);
  let length = 0;
  for (const v of raw) length += v * v;
  length = Math.sqrt(length);
  return Float32Array.from(raw, (v) => v / length);
}

/** Square RGB bytes as a 1×3×size×size tensor: (x / 255 − mean) / std per channel. */
function toTensor(rgb: Uint8Array, size: number, mean: number[], std: number[]) {
  const plane = size * size;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (rgb[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
  }
  return new ort.Tensor("float32", input, [1, 3, size, size]);
}

function median(values: number[]) {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return `${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms`;
}

function summarise(name: string, values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return console.log(`${name}: no pairs`);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(3);
  console.log(
    `${name} (${sorted.length} pairs): min ${sorted[0]!.toFixed(3)}  p5 ${at(5)}  median ${at(50)}  p95 ${at(95)}  max ${sorted.at(-1)!.toFixed(3)}`,
  );
}

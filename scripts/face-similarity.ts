// Prints cosine-similarity statistics for a labelled sample of Photos, to check
// the Suggestion and Stranger thresholds in src/server/faces/thresholds.ts.
//
//   pixi run similarity <sample-dir>
//
// <sample-dir> holds one folder per person (any name), each holding Photos of
// that person (JPEG, PNG or WebP). The largest Face in each Photo is taken to be
// theirs. Nothing is stored or sent anywhere and only numbers are printed. Keep
// the sample itself off GitHub.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFaceDetector } from "../src/server/faces/detector.ts";
import { STRANGER_THRESHOLD, SUGGESTION_THRESHOLD } from "../src/server/faces/thresholds.ts";

const sampleDir = process.argv[2];
if (!sampleDir) {
  console.error("Usage: pixi run similarity <sample-dir>   (one folder per person, holding Photos of them)");
  process.exit(2);
}

const detector = await loadFaceDetector(process.env["MODELS_DIR"] ?? join(import.meta.dirname, "../models"));
const faces: { person: number; embedding: Float32Array }[] = [];
let photos = 0;
let missed = 0;
const folders = (await readdir(sampleDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
for (const [person, folder] of folders.entries()) {
  for (const file of (await readdir(join(sampleDir, folder.name))).sort()) {
    if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
    photos++;
    const found = await detector.detect({ kind: "encoded", bytes: await readFile(join(sampleDir, folder.name, file)) });
    const largest = found.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
    if (largest) faces.push({ person, embedding: largest.embedding });
    else missed++;
  }
}

const same: number[] = [];
const different: number[] = [];
for (let i = 0; i < faces.length; i++) {
  for (let j = i + 1; j < faces.length; j++) {
    const a = faces[i]!;
    const b = faces[j]!;
    let dot = 0;
    for (let k = 0; k < a.embedding.length; k++) dot += a.embedding[k]! * b.embedding[k]!;
    (a.person === b.person ? same : different).push(dot);
  }
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
function summarise(name: string, values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return console.log(`${name}: no pairs`);
  const at = (p: number) => percentile(sorted, p).toFixed(3);
  console.log(
    `${name} (${sorted.length} pairs): min ${sorted[0]!.toFixed(3)}  p5 ${at(5)}  median ${at(50)}  p95 ${at(95)}  max ${sorted.at(-1)!.toFixed(3)}`,
  );
}

console.log(`${folders.length} people, ${photos} Photos, ${missed} with no Face found\n`);
summarise("Same person     ", same);
summarise("Different people", different);
console.log("\nthreshold   same-person pairs at or above   different-people pairs at or above");
for (const t of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  const share = (values: number[]) =>
    values.length === 0 ? "-" : `${((100 * values.filter((v) => v >= t).length) / values.length).toFixed(1)}%`;
  const mark = t === SUGGESTION_THRESHOLD ? "   <- Suggestion" : t === STRANGER_THRESHOLD ? "   <- Stranger" : "";
  console.log(`${t.toFixed(2).padStart(9)}   ${share(same).padStart(29)}   ${share(different).padStart(34)}${mark}`);
}

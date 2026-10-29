// The real buffalo_sc, D-FINE-S and Avito models for API-seam tests: fetch them
// with `pixi run models`. global-setup.ts checks their SHA-256s once for the
// whole run, so each test file loads them without hashing the 1.2 GB Avito model
// again. Each session gets two threads: test files run side by side, and with
// one thread per core each they oversubscribe the CPU until hooks time out.
import { join } from "node:path";
import { loadFaceDetector } from "../faces/detector.ts";
import { loadAnimalDetector } from "../pets/detector.ts";

export const modelsDir = join(import.meta.dirname, "../../../models");

const options = { verify: false, threads: 2 };
export const loadTestFaceDetector = () => loadFaceDetector(modelsDir, options);
export const loadTestAnimalDetector = () => loadAnimalDetector(modelsDir, options);

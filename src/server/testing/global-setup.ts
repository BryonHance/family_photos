// Checks every model file against its SHA-256 once, before any API-seam test
// file loads them (see models.ts). A missing or corrupt model stops the run
// with the server's own message naming `pixi run models`.
import { verifyFaceModels } from "../faces/detector.ts";
import { verifyAnimalModels } from "../pets/detector.ts";
import { ModelError } from "../recognition/models.ts";
import { modelsDir } from "./models.ts";

export default async function verifyModels() {
  try {
    await verifyFaceModels(modelsDir);
    await verifyAnimalModels(modelsDir);
  } catch (error) {
    // Vite fails to source-map the stack of an error thrown here and reports its
    // own TypeError instead, so the message would be lost. It needs no stack.
    if (error instanceof ModelError) error.stack = `ModelError: ${error.message}`;
    throw error;
  }
}

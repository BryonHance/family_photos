import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A face or pet model file is missing or does not match its pinned or recorded SHA-256. */
export class ModelError extends Error {}

/** Which models a file belongs to, for the message that names it: "Face model …" or "Pet model …". */
export type ModelKind = "Face" | "Pet";

/**
 * Checks every model file listed in `pinnedList` (lines of `<sha256>  <file>`,
 * as `sha256sum` writes them, shared with the script that downloads them)
 * against the copy in `dir`. Throws a ModelError naming `pixi run models` when
 * a file is missing or does not match.
 */
export async function verifyPinnedModels(kind: ModelKind, pinnedList: string, dir: string) {
  const list = await readFile(pinnedList, "utf8");
  for (const line of list.split("\n").filter((l) => l.trim() !== "")) {
    const [expected, name] = line.trim().split(/\s+/) as [string, string];
    const path = join(dir, name);
    const actual = await sha256(path);
    if (actual === undefined) {
      throw new ModelError(`${kind} model ${path} is missing. Run \`pixi run models\` to download it.`);
    }
    if (actual !== expected) {
      throw new ModelError(
        `${kind} model ${path} does not match its pinned SHA-256. Run \`pixi run models\` to download it again.`,
      );
    }
  }
}

/**
 * Checks an exported model file, which is not pinned like a download, against
 * the SHA-256 its export recorded beside it in `<path>.sha256` (in sha256sum's
 * format, so that `sha256sum --check` reads it too). Throws a ModelError naming
 * `pixi run models` when either is missing or they do not match.
 */
export async function verifyExportedModel(kind: ModelKind, path: string) {
  const recorded = await readFile(`${path}.sha256`, "utf8").then(
    (text) => text.trim().split(/\s+/)[0],
    () => undefined,
  );
  const actual = recorded === undefined ? undefined : await sha256(path);
  if (actual === undefined) {
    throw new ModelError(`${kind} model ${path} or its recorded SHA-256 is missing. Run \`pixi run models\` to export it.`);
  }
  if (actual !== recorded) {
    throw new ModelError(
      `${kind} model ${path} does not match its recorded SHA-256. Run \`pixi run models\` to export it again.`,
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

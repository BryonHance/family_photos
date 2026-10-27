import type { Box } from "../../shared/analysis.ts";

/** Intersection over union: how much two boxes overlap, from 0 (apart) to 1 (the same box). */
export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = w * h;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

/**
 * For each detected box, the old one it inherits from: the one it overlaps by
 * at least `minIou`, the pairs that overlap most matched first, and each old
 * one passing to one new box at most. Used when a model change detects a Photo again.
 */
export function heirsOf<Old>(old: Old[], boxOfOld: (old: Old) => Box, detected: Box[], minIou: number): (Old | undefined)[] {
  const pairs = detected
    .flatMap((box, i) => old.map((o, j) => ({ i, j, overlap: iou(box, boxOfOld(o)) })))
    .filter((p) => p.overlap >= minIou)
    .sort((a, b) => b.overlap - a.overlap);
  const heirs: (Old | undefined)[] = detected.map(() => undefined);
  const used = new Set<number>();
  for (const { i, j } of pairs) {
    if (heirs[i] || used.has(j)) continue;
    heirs[i] = old[j];
    used.add(j);
  }
  return heirs;
}

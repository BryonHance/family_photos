import type { Box } from "../../shared/analysis.ts";

/** Intersection over union: how much two boxes overlap, from 0 (apart) to 1 (the same box). */
export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = w * h;
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}

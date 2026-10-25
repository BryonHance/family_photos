/** Upright RGB pixels, row by row, 3 bytes per pixel. */
export type RgbImage = { width: number; height: number; data: Uint8Array };

/** A point in pixels of an RgbImage. */
export type PixelPoint = { x: number; y: number };

export const ALIGNED_SIZE = 112;

/**
 * Where ArcFace-family recognizers expect the eyes, nose tip and mouth corners
 * in a 112×112 crop: InsightFace's `norm_crop` template (see
 * docs/research/face-recognition-on-cpu.md §4).
 */
const ARCFACE_TEMPLATE: readonly PixelPoint[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

/**
 * Warps a Face onto the ArcFace template: the similarity transform (scale,
 * rotation, translation; no reflection) that maps its five landmarks onto the
 * template by least squares, which is Umeyama's estimate in 2D, then a bilinear
 * sample of each output pixel, black outside the image, as `cv2.warpAffine` does.
 * Returns 112×112 RGB in memory only: no image of a Face is ever written (ADR-0002).
 */
export function alignFace(image: RgbImage, landmarks: readonly PixelPoint[]): RgbImage {
  const { a, b, tx, ty } = similarityTransform(landmarks, ARCFACE_TEMPLATE);
  // Inverse of [a −b; b a]: 1/(a²+b²) · [a b; −b a].
  const det = a * a + b * b;
  const out = new Uint8Array(ALIGNED_SIZE * ALIGNED_SIZE * 3);
  for (let v = 0; v < ALIGNED_SIZE; v++) {
    for (let u = 0; u < ALIGNED_SIZE; u++) {
      const du = u - tx;
      const dv = v - ty;
      const x = (a * du + b * dv) / det;
      const y = (-b * du + a * dv) / det;
      sampleBilinear(image, x, y, out, (v * ALIGNED_SIZE + u) * 3);
    }
  }
  return { width: ALIGNED_SIZE, height: ALIGNED_SIZE, data: out };
}

/** Least-squares x' = a·x − b·y + tx, y' = b·x + a·y + ty from `from` onto `to`. */
function similarityTransform(from: readonly PixelPoint[], to: readonly PixelPoint[]) {
  const mean = (points: readonly PixelPoint[]) => ({
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  });
  const mf = mean(from);
  const mt = mean(to);
  let dot = 0;
  let cross = 0;
  let norm = 0;
  from.forEach((p, i) => {
    const xs = p.x - mf.x;
    const ys = p.y - mf.y;
    const xd = to[i]!.x - mt.x;
    const yd = to[i]!.y - mt.y;
    dot += xs * xd + ys * yd;
    cross += xs * yd - ys * xd;
    norm += xs * xs + ys * ys;
  });
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: mt.x - (a * mf.x - b * mf.y), ty: mt.y - (b * mf.x + a * mf.y) };
}

function sampleBilinear({ width, height, data }: RgbImage, x: number, y: number, out: Uint8Array, at: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const pixel = (px: number, py: number) =>
      px < 0 || py < 0 || px >= width || py >= height ? 0 : data[(py * width + px) * 3 + c]!;
    const top = pixel(x0, y0) * (1 - fx) + pixel(x0 + 1, y0) * fx;
    const bottom = pixel(x0, y0 + 1) * (1 - fx) + pixel(x0 + 1, y0 + 1) * fx;
    out[at + c] = Math.round(top * (1 - fy) + bottom * fy);
  }
}

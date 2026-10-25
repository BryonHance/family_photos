/**
 * How alike two Faces' embeddings are: their cosine similarity, from −1 to 1.
 * Embeddings are L2-normalised, so it is their dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * How alike two embeddings are (two Faces, or two Animals): their cosine similarity, from −1 to 1.
 * Embeddings are L2-normalised, so it is their dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** The embedding a BLOB holds, as float32s, copied so that its alignment does not matter. Faces and Animals alike. */
export const embeddingOf = (blob: Uint8Array) => new Float32Array(new Uint8Array(blob).buffer);

/** A set of pairs, such as (Face, rejected Person) or (Animal, rejected Pet). */
export function pairSet<A, B>(pairs: Iterable<readonly [A, B]>) {
  const byFirst = new Map<A, Set<B>>();
  for (const [a, b] of pairs) byFirst.set(a, (byFirst.get(a) ?? new Set<B>()).add(b));
  return { has: (a: A, b: B) => byFirst.get(a)?.has(b) ?? false };
}

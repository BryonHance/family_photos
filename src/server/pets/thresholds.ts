/**
 * How alike two Animals' embeddings must be (cosine similarity) for the viewer
 * to act on it. Starting points from the trial on our five pets (spec #20,
 * research note §8), to be checked with `pixi run pet-trial <sample-dir>`.
 */

/** An Animal is suggested as the Pet of its nearest named Animal at or above this. */
export const SUGGESTION_THRESHOLD = 0.65;

/** An unnamed Animal joins the Unknown pet of its most similar Animal at or above this. */
export const UNKNOWN_PET_THRESHOLD = 0.7;

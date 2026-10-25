/**
 * How alike two Faces' embeddings must be (cosine similarity) for the viewer to
 * act on it. Starting points from the spec (#12), to be checked against a small
 * labelled sample of our own Photos with `pixi run similarity <sample-dir>`.
 */

/** A Face is suggested as the Person of its nearest named Face at or above this. */
export const SUGGESTION_THRESHOLD = 0.5;

/** An unnamed Face joins the Stranger of its most similar Face at or above this. */
export const STRANGER_THRESHOLD = 0.6;

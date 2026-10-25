// The browser's side of the face routes in src/server/faces/api.ts.
import type { Face, PersonRef, PersonSummary } from "../shared/analysis.ts";

/** A face route refused the request; the message is the server's, ready to show. */
export class FaceApiError extends Error {}

async function send(method: string, url: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new FaceApiError("The server could not be reached. Check the connection and try again.");
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    throw new FaceApiError(problem?.error?.message ?? "The server could not do that. Try again.");
  }
  return res;
}

export const faceApi = {
  nameFace: async (faceId: string, name: string) =>
    (await (await send("PUT", `/api/faces/${encodeURIComponent(faceId)}/person`, { name })).json()) as PersonRef,
  confirmSuggestion: async (faceId: string, personId: string) =>
    (await (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/suggestion/confirm`, { personId })).json()) as PersonRef,
  /** Returns the Face as it now stands. */
  rejectSuggestion: async (faceId: string, personId: string) =>
    (await (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/suggestion/reject`, { personId })).json()) as Face,
  markNotAFace: async (faceId: string) => void (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/not-a-face`)),
  people: async () => ((await (await send("GET", "/api/people")).json()) as { people: PersonSummary[] }).people,
  renamePerson: async (personId: string, name: string) =>
    (await (await send("PATCH", `/api/people/${encodeURIComponent(personId)}`, { name })).json()) as PersonRef,
  mergePeople: async (personId: string, intoPersonId: string) =>
    void (await send("POST", `/api/people/${encodeURIComponent(personId)}/merge`, { into: intoPersonId })),
  deletePerson: async (personId: string) => void (await send("DELETE", `/api/people/${encodeURIComponent(personId)}`)),
  deleteAllFaceData: async () => void (await send("DELETE", "/api/face-data")),
};

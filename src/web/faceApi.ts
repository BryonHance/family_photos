// The browser's side of the face routes in src/server/faces/api.ts. The pet routes are in petApi.ts.
import type { Face, PersonRef, PersonSummary } from "../shared/analysis.ts";
import { send } from "./api.ts";

export const faceApi = {
  nameFace: async (faceId: string, name: string) =>
    (await (await send("PUT", `/api/faces/${encodeURIComponent(faceId)}/person`, { name })).json()) as PersonRef,
  confirmSuggestion: async (faceId: string, personId: string) =>
    (await (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/suggestion/confirm`, { personId })).json()) as PersonRef,
  /** Returns the Face as it now stands. */
  rejectSuggestion: async (faceId: string, personId: string) =>
    (await (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/suggestion/reject`, { personId })).json()) as Face,
  /** The Faces of the Photo a Face is in, as the server now has them. */
  facesOfPhotoOf: async (faceId: string) =>
    ((await (await send("GET", `/api/faces/${encodeURIComponent(faceId)}/photo`)).json()) as { faces: Face[] }).faces,
  markNotAFace: async (faceId: string) => void (await send("POST", `/api/faces/${encodeURIComponent(faceId)}/not-a-face`)),
  people: async () => ((await (await send("GET", "/api/people")).json()) as { people: PersonSummary[] }).people,
  renamePerson: async (personId: string, name: string) =>
    (await (await send("PATCH", `/api/people/${encodeURIComponent(personId)}`, { name })).json()) as PersonRef,
  mergePeople: async (personId: string, intoPersonId: string) =>
    void (await send("POST", `/api/people/${encodeURIComponent(personId)}/merge`, { into: intoPersonId })),
  deletePerson: async (personId: string) => void (await send("DELETE", `/api/people/${encodeURIComponent(personId)}`)),
  /** Face and pet data go together (ADR-0003). */
  deleteAllFaceAndPetData: async () => void (await send("DELETE", "/api/face-and-pet-data")),
};

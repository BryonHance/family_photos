// The browser's side of the pet routes in src/server/pets/api.ts.
import type { PetRef, PetSummary } from "../shared/analysis.ts";
import { send } from "./faceApi.ts";

export const petApi = {
  nameAnimal: async (animalId: string, name: string) =>
    (await (await send("PUT", `/api/animals/${encodeURIComponent(animalId)}/pet`, { name })).json()) as PetRef,
  markNotAPet: async (animalId: string) => void (await send("POST", `/api/animals/${encodeURIComponent(animalId)}/not-a-pet`)),
  pets: async () => ((await (await send("GET", "/api/pets")).json()) as { pets: PetSummary[] }).pets,
};

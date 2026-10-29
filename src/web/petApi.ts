// The browser's side of the pet routes in src/server/pets/api.ts.
import type { Animal, PetRef, PetSummary } from "../shared/analysis.ts";
import { send } from "./api.ts";

export const petApi = {
  nameAnimal: async (animalId: string, name: string) =>
    (await (await send("PUT", `/api/animals/${encodeURIComponent(animalId)}/pet`, { name })).json()) as PetRef,
  confirmSuggestion: async (animalId: string, petId: string) =>
    (await (await send("POST", `/api/animals/${encodeURIComponent(animalId)}/suggestion/confirm`, { petId })).json()) as PetRef,
  /** Returns the Animal as it now stands. */
  rejectSuggestion: async (animalId: string, petId: string) =>
    (await (await send("POST", `/api/animals/${encodeURIComponent(animalId)}/suggestion/reject`, { petId })).json()) as Animal,
  /** The Animals of the Photo an Animal is in, as the server now has them. */
  animalsOfPhotoOf: async (animalId: string) =>
    ((await (await send("GET", `/api/animals/${encodeURIComponent(animalId)}/photo`)).json()) as { animals: Animal[] })
      .animals,
  markNotAPet: async (animalId: string) => void (await send("POST", `/api/animals/${encodeURIComponent(animalId)}/not-a-pet`)),
  pets: async () => ((await (await send("GET", "/api/pets")).json()) as { pets: PetSummary[] }).pets,
  renamePet: async (petId: string, name: string) =>
    (await (await send("PATCH", `/api/pets/${encodeURIComponent(petId)}`, { name })).json()) as PetRef,
  mergePets: async (petId: string, intoPetId: string) =>
    void (await send("POST", `/api/pets/${encodeURIComponent(petId)}/merge`, { into: intoPetId })),
  deletePet: async (petId: string) => void (await send("DELETE", `/api/pets/${encodeURIComponent(petId)}`)),
};

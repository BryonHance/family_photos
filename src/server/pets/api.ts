import { Hono, type Context } from "hono";
import type { Animal, PetRef, PetSummary } from "../../shared/analysis.ts";
import { fieldIn, nameIn } from "../recognition/request.ts";
import type { PetStore } from "./store.ts";

/**
 * Naming Animals and managing Pets, apart from the face routes: a Pet's name is
 * never offered for a Face, nor a Person's for an Animal, and a Pet never
 * merges with a Person. Animals themselves
 * come back from /api/analyze, with the ids these routes take.
 */
export function petRoutes(store: PetStore) {
  const app = new Hono();

  const problem = (c: Context, status: 400 | 404 | 409, message: string) => c.json({ error: { message } }, status);
  const noSuchAnimal = (c: Context) => problem(c, 404, "This Animal is no longer stored. Open the Photo again.");
  const noSuchPet = (c: Context) => problem(c, 404, "There is no such Pet.");
  const noName = (c: Context) => problem(c, 400, "Give a name.");

  // The opened Photo's Animals after a change in the People and pets panel.
  app.get("/animals/:id/photo", (c) => {
    const animals = store.animalsOfPhotoOf(c.req.param("id"));
    return animals === "no-region" ? noSuchAnimal(c) : c.json<{ animals: Animal[] }>({ animals });
  });

  app.put("/animals/:id/pet", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const pet = store.nameAnimal(c.req.param("id"), name);
    return pet === "no-region" ? noSuchAnimal(c) : c.json<PetRef>(pet);
  });

  // ✓ and ✕ on a Suggestion. The body names the suggested Pet, so that what is
  // confirmed or rejected is what the user saw.
  app.post("/animals/:id/suggestion/:verdict{confirm|reject}", async (c) => {
    const petId = await fieldIn(c, "petId");
    if (typeof petId !== "string") return problem(c, 400, "Say which Pet was suggested.");
    const animalId = c.req.param("id");
    const result =
      c.req.param("verdict") === "confirm" ? store.confirmSuggestion(animalId, petId) : store.rejectSuggestion(animalId, petId);
    if (result === "no-region") return noSuchAnimal(c);
    if (result === "no-known") return noSuchPet(c);
    return c.json(result);
  });

  app.post("/animals/:id/not-a-pet", (c) =>
    store.markNotAPet(c.req.param("id")) ? c.body(null, 204) : noSuchAnimal(c),
  );

  app.get("/pets", (c) => c.json<{ pets: PetSummary[] }>({ pets: store.pets() }));

  app.patch("/pets/:id", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const result = store.renamePet(c.req.param("id"), name);
    if (result === "no-known") return noSuchPet(c);
    if (result === "name-taken") return problem(c, 409, `A Pet is already called ${name}. Merge them instead.`);
    return c.json<PetRef>(result);
  });

  app.post("/pets/:id/merge", async (c) => {
    const into = await fieldIn(c, "into");
    if (typeof into !== "string") return problem(c, 400, "Say which Pet to merge into.");
    const result = store.mergePets(c.req.param("id"), into);
    if (result === "same-known") return problem(c, 400, "A Pet cannot be merged into itself.");
    if (result === "no-known") return noSuchPet(c);
    return c.body(null, 204);
  });

  app.delete("/pets/:id", (c) => (store.deletePet(c.req.param("id")) ? c.body(null, 204) : noSuchPet(c)));

  return app;
}

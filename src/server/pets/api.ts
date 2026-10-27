import { Hono, type Context } from "hono";
import type { PetRef, PetSummary } from "../../shared/analysis.ts";
import { nameIn } from "../faces/api.ts";
import type { PetStore } from "./store.ts";

/**
 * Naming Animals and listing Pets, apart from the face routes: a Pet's name is
 * never offered for a Face, nor a Person's for an Animal. Animals themselves
 * come back from /api/analyze, with the ids these routes take.
 */
export function petRoutes(store: PetStore) {
  const app = new Hono();

  const problem = (c: Context, status: 400 | 404 | 409, message: string) => c.json({ error: { message } }, status);
  const noSuchAnimal = (c: Context) => problem(c, 404, "This Animal is no longer stored. Open the Photo again.");
  const noSuchPet = (c: Context) => problem(c, 404, "There is no such Pet.");
  const noName = (c: Context) => problem(c, 400, "Give a name.");

  app.put("/animals/:id/pet", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const pet = store.nameAnimal(c.req.param("id"), name);
    return pet === "no-animal" ? noSuchAnimal(c) : c.json<PetRef>(pet);
  });

  app.post("/animals/:id/not-a-pet", (c) =>
    store.markNotAPet(c.req.param("id")) ? c.body(null, 204) : noSuchAnimal(c),
  );

  app.get("/pets", (c) => c.json<{ pets: PetSummary[] }>({ pets: store.pets() }));

  app.patch("/pets/:id", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const result = store.renamePet(c.req.param("id"), name);
    if (result === "no-pet") return noSuchPet(c);
    if (result === "name-taken") return problem(c, 409, `A Pet is already called ${name}. Merge them instead.`);
    return c.json<PetRef>(result);
  });

  return app;
}

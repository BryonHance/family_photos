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

  const noSuchAnimal = (c: Context) =>
    c.json({ error: { message: "This Animal is no longer stored. Open the Photo again." } }, 404);

  app.put("/animals/:id/pet", async (c) => {
    const name = await nameIn(c);
    if (!name) return c.json({ error: { message: "Give a name." } }, 400);
    const pet = store.nameAnimal(c.req.param("id"), name);
    return pet === "no-animal" ? noSuchAnimal(c) : c.json<PetRef>(pet);
  });

  app.post("/animals/:id/not-a-pet", (c) =>
    store.markNotAPet(c.req.param("id")) ? c.body(null, 204) : noSuchAnimal(c),
  );

  app.get("/pets", (c) => c.json<{ pets: PetSummary[] }>({ pets: store.pets() }));

  return app;
}

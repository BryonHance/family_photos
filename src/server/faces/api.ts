import { Hono, type Context } from "hono";
import type { PersonRef, PersonSummary } from "../../shared/analysis.ts";
import type { FaceStore } from "./store.ts";

/**
 * Naming Faces and managing People. Faces themselves come back from
 * /api/analyze, with the ids these routes take.
 */
export function faceRoutes(store: FaceStore) {
  const app = new Hono();

  const problem = (c: Context, status: 400 | 404, message: string) => c.json({ error: { message } }, status);
  const noSuchFace = (c: Context) => problem(c, 404, "This Face is no longer stored. Open the Photo again.");
  const noSuchPerson = (c: Context) => problem(c, 404, "There is no such Person.");
  const noName = (c: Context) => problem(c, 400, "Give a name.");

  app.put("/faces/:id/person", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const person = store.nameFace(c.req.param("id"), name);
    return person ? c.json<PersonRef>(person) : noSuchFace(c);
  });

  app.post("/faces/:id/not-a-face", (c) =>
    store.markNotAFace(c.req.param("id")) ? c.body(null, 204) : noSuchFace(c),
  );

  app.get("/people", (c) => c.json<{ people: PersonSummary[] }>({ people: store.people() }));

  return app;
}

/** The `name` of a JSON body, without spaces around it; undefined when there is none. */
async function nameIn(c: Context): Promise<string | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const name = typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

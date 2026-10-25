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
    return person === "no-face" ? noSuchFace(c) : c.json<PersonRef>(person);
  });

  // ✓ and ✕ on a Suggestion. The body names the suggested Person, so that what
  // is confirmed or rejected is what the user saw.
  app.post("/faces/:id/suggestion/:verdict{confirm|reject}", async (c) => {
    const personId = await fieldIn(c, "personId");
    if (typeof personId !== "string") return problem(c, 400, "Say which Person was suggested.");
    const faceId = c.req.param("id");
    const result =
      c.req.param("verdict") === "confirm"
        ? store.confirmSuggestion(faceId, personId)
        : store.rejectSuggestion(faceId, personId);
    if (result === "no-face") return noSuchFace(c);
    if (result === "no-person") return noSuchPerson(c);
    return c.json(result);
  });

  app.post("/faces/:id/not-a-face", (c) =>
    store.markNotAFace(c.req.param("id")) ? c.body(null, 204) : noSuchFace(c),
  );

  app.get("/people", (c) => c.json<{ people: PersonSummary[] }>({ people: store.people() }));

  app.patch("/people/:id", async (c) => {
    const name = await nameIn(c);
    if (!name) return noName(c);
    const result = store.renamePerson(c.req.param("id"), name);
    if (result === "no-person") return noSuchPerson(c);
    if (result === "name-taken") {
      return c.json({ error: { message: `Someone is already called ${name}. Merge them instead.` } }, 409);
    }
    return c.json<PersonRef>(result);
  });

  app.post("/people/:id/merge", async (c) => {
    const into = await fieldIn(c, "into");
    if (typeof into !== "string") return problem(c, 400, "Say which Person to merge into.");
    const result = store.mergePeople(c.req.param("id"), into);
    if (result === "same-person") return problem(c, 400, "A Person cannot be merged into themselves.");
    if (result === "no-person") return noSuchPerson(c);
    return c.body(null, 204);
  });

  app.delete("/people/:id", (c) => (store.deletePerson(c.req.param("id")) ? c.body(null, 204) : noSuchPerson(c)));

  app.delete("/face-data", (c) => {
    store.deleteAllFaceData();
    return c.body(null, 204);
  });

  return app;
}

/** One field of a JSON body, of whatever type; undefined when the body is not a JSON object or lacks it. */
async function fieldIn(c: Context, field: string): Promise<unknown> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null && field in body ? (body as Record<string, unknown>)[field] : undefined;
}

/** The `name` of a JSON body, without spaces around it; undefined when there is none. */
async function nameIn(c: Context): Promise<string | undefined> {
  const name = await fieldIn(c, "name");
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

// What the face and pet routes read from a request body alike.
import type { Context } from "hono";

/** One field of a JSON body, of whatever type; undefined when the body is not a JSON object or lacks it. */
export async function fieldIn(c: Context, field: string): Promise<unknown> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null && field in body ? (body as Record<string, unknown>)[field] : undefined;
}

/** The `name` of a JSON body, without spaces around it; undefined when there is none. */
export async function nameIn(c: Context): Promise<string | undefined> {
  const name = await fieldIn(c, "name");
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

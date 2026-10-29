// What the browser's face and pet route clients (faceApi.ts, petApi.ts) share.

/** A face or pet route refused the request; the message is the server's, ready to show. */
export class ApiError extends Error {}

/** What to show the user for a failed request. */
export const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

export async function send(method: string, url: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The server could not be reached. Check the connection and try again.");
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    throw new ApiError(problem?.error?.message ?? "The server could not do that. Try again.");
  }
  return res;
}

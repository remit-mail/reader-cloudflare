export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const json = (status: number, body: unknown, headers: HeadersInit = {}): Response => {
  const response = Response.json(body, { status, headers });
  response.headers.set("cache-control", "no-store");
  return response;
};

export const notFound = (): Response => text(404, "Not found");

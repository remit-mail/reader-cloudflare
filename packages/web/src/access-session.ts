import type { OfflineOptions } from "@remit/web-client/offline";

export const verifySession: OfflineOptions["verifySession"] = async () => {
  const response = await fetch("/api/session", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
    return null;
  }
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json"
  ) {
    throw new Error(`GET /api/session returned an invalid response (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("partitionKey" in body) ||
    typeof body.partitionKey !== "string" ||
    !body.partitionKey.trim()
  ) {
    throw new Error("GET /api/session returned an invalid partition key.");
  }
  return { partitionKey: body.partitionKey };
};

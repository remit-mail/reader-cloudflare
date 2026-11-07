const READY_CAP_MS = 3 * 60_000;
const RETRY_MS = 10_000;
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const notReadyYet = (error: unknown): boolean => {
  const cause = isRecord(error) ? error.cause : undefined;
  if (!isRecord(cause)) return false;
  if (typeof cause.code === "string" && DNS_CODES.has(cause.code)) return true;
  if (typeof cause.code === "string" && cause.code.startsWith("ERR_SSL_")) return true;
  return cause.library === "SSL routines";
};

const describe = (error: unknown): string => {
  const cause = isRecord(error) ? error.cause : undefined;
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
};

export const fetchOnceServed = async (url: URL, init?: RequestInit): Promise<Response> => {
  const deadline = Date.now() + READY_CAP_MS;
  for (;;) {
    const outcome = await fetch(url, init).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    if ("response" in outcome) return outcome.response;
    if (!notReadyYet(outcome.error)) throw outcome.error;
    if (Date.now() + RETRY_MS > deadline) {
      throw new Error(
        `${url.host} still fails its TLS handshake or DNS lookup (${describe(outcome.error)}) ${READY_CAP_MS / 60_000} minutes after deploy; check the custom domain and its certificate in the Cloudflare dashboard`,
      );
    }
    console.log(`${url.host} is not served yet (${describe(outcome.error)}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
};

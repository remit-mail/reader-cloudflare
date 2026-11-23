import ipaddr from "ipaddr.js";
import { z } from "zod";
import { apiError, withPartition } from "./http";
import { log } from "./log";

export const IMAGE_PROXY_PATH = "/api/image-proxy";
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 10;
const USER_AGENT = "Remit-Image-Proxy/1.0";
const dnsAnswer = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const destination = (value: string | null): URL => {
  const url = value === null ? null : URL.parse(value);
  if (!url) throw new Refusal(400, "Provide an absolute image URL");
  if (!["http:", "https:"].includes(url.protocol)) throw new Refusal(403, "Scheme refused");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Refusal(403, "Port refused");
  if (url.username || url.password) throw new Refusal(403, "URL credentials refused");
  const host = url.hostname.replace(/\.$/, "");
  if (
    host.startsWith("[") ||
    ipaddr.isValid(host) ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
    host.endsWith(".home.arpa") ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Refusal(403, "Hostname refused");
  url.hostname = host;
  url.hash = "";
  return url;
};

const publicAddress = (address: string): boolean => {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.parse(address);
  // Reject mapped/transition addresses too, even when the embedded IPv4 is public.
  if (ip.range() !== "unicast") return false;
  return ip.kind() === "ipv4" || ((ip.toByteArray()[0] ?? 0) & 0xe0) === 0x20;
};

const validateDns = async (host: string, signal: AbortSignal): Promise<void> => {
  const answers = await Promise.all(
    [1, 28].map(async (type) => {
      const query = new URL("https://cloudflare-dns.com/dns-query");
      query.searchParams.set("name", host);
      query.searchParams.set("type", String(type));
      const response = await fetch(query, {
        headers: { Accept: "application/dns-json", "User-Agent": USER_AGENT },
        redirect: "manual",
        signal,
      });
      if (response.status !== 200) throw new Error("DNS lookup failed");
      const answer = dnsAnswer.parse(await response.json());
      if (answer.Status !== 0) throw new Refusal(403, "DNS destination unavailable");
      return (answer.Answer ?? []).filter((record) => record.type === 1 || record.type === 28);
    }),
  );
  const addresses = answers.flat();
  if (!addresses.length || addresses.some((record) => !publicAddress(record.data))) {
    throw new Refusal(403, "DNS destination refused");
  }
};

// Pull one chunk at a time: no whole-image buffer and no unchecked Content-Length.
const limitedBody = (
  body: ReadableStream<Uint8Array>,
  abort: AbortController,
  timer: ReturnType<typeof setTimeout>,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let bytes = 0;
  const cancelUpstream = () => {
    void reader.cancel().catch(() => undefined);
  };
  abort.signal.addEventListener("abort", cancelUpstream, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", cancelUpstream);
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        if (abort.signal.aborted) throw new Error("Image deadline exceeded");
        const chunk = await reader.read();
        if (abort.signal.aborted) throw new Error("Image deadline exceeded");
        if (chunk.done) {
          cleanup();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        if (bytes > IMAGE_MAX_BYTES) throw new Error("Image exceeds size limit");
        controller.enqueue(chunk.value);
      } catch {
        cleanup();
        abort.abort();
        await reader.cancel().catch(() => undefined);
        controller.error(new Error("Image stream refused or interrupted"));
      }
    },
    async cancel() {
      cleanup();
      abort.abort();
      await reader.cancel();
    },
  });
};

export const serveImageProxy = async (
  request: Request,
  partitionKey: string,
): Promise<Response> => {
  if (request.method !== "GET") {
    return apiError(405, "MethodNotAllowed", "Load images with GET", {
      Allow: "GET",
      "Cache-Control": "no-store",
    });
  }
  let url: URL;
  try {
    url = destination(new URL(request.url).searchParams.get("url"));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return apiError(error.status, "ImageRefused", error.message, { "Cache-Control": "no-store" });
  }
  log.info("external image requested", { host: url.hostname });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    let upstream: Response | undefined;
    try {
      await validateDns(url.hostname, abort.signal);
      // Workers fetch enforces its own private-network boundary at connection time.
      // Do not use resolveOverride: it cannot pin arbitrary external destinations.
      upstream = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: abort.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
        cache: "no-store",
      });
      if ([408, 429, 500, 502, 503, 504].includes(upstream.status))
        throw new Error("Transient upstream failure");
      if (upstream.status >= 300 && upstream.status < 400)
        throw new Refusal(403, "Image redirects refused");
      if (upstream.status !== 200 || !upstream.body)
        throw new Refusal(502, "Image upstream refused");
      const mime = ((upstream.headers.get("Content-Type") ?? "").split(";")[0] ?? "")
        .trim()
        .toLowerCase();
      if (!/^image\/[a-z0-9!#$&^_.+-]+$/.test(mime) || mime === "image/svg+xml") {
        throw new Refusal(415, "Image MIME refused");
      }
      if (Number(upstream.headers.get("Content-Length")) > IMAGE_MAX_BYTES)
        throw new Refusal(413, "Image exceeds size limit");
      return withPartition(
        new Response(limitedBody(upstream.body, abort, timer), {
          headers: {
            "Content-Type": mime,
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          },
        }),
        partitionKey,
      );
    } catch (error) {
      clearTimeout(timer);
      abort.abort();
      await upstream?.body?.cancel().catch(() => undefined);
      if (error instanceof Refusal)
        return apiError(error.status, "ImageRefused", error.message, {
          "Cache-Control": "no-store",
        });
      // Fetch/DNS errors can contain the complete tracking URL: never log them.
      log.warn("external image attempt failed", { host: url.hostname, attempt });
      if (attempt === MAX_ATTEMPTS)
        return apiError(502, "ImageUnavailable", "Image unavailable after 10 attempts", {
          "Cache-Control": "no-store",
        });
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
  throw new Error("Unreachable image retry state");
};

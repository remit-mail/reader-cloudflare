import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES, serveImageProxy } from "../../src/image-proxy";

const request = (url: string, init: RequestInit = {}): Request =>
  new Request(`https://app.remit.test/api/image-proxy?url=${encodeURIComponent(url)}`, init);
const image = (headers: Record<string, string> = {}): Response =>
  new Response("image bytes", {
    headers: { "Content-Type": "image/png", ...headers },
  });
const network = (
  upstream: () => Response | Promise<Response> = image,
  addresses = ["93.184.215.14"],
): ReturnType<typeof vi.fn> => {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") {
      const type = Number(url.searchParams.get("type"));
      return Response.json({ Status: 0, Answer: addresses.map((data) => ({ type, data })) });
    }
    expect(init?.redirect).toBe("manual");
    return upstream();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("external image proxy", () => {
  it("refuses missing or malformed URLs with 400", async () => {
    for (const url of ["", "not a URL"])
      expect((await serveImageProxy(request(url), "tenant")).status).toBe(400);
  });
  it("refuses non-HTTP schemes with 403 before fetching", async () => {
    const fetch = network();
    expect(
      (await serveImageProxy(request("ftp://images.example.org/a.png"), "tenant")).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses nonstandard ports with 403", async () => {
    expect(
      (await serveImageProxy(request("https://images.example.org:8080/a.png"), "tenant")).status,
    ).toBe(403);
  });
  it("refuses embedded credentials with 403", async () => {
    expect(
      (await serveImageProxy(request("https://user:password@example.org/a.png"), "tenant")).status,
    ).toBe(403);
  });
  it("refuses public and alternate-form IP literals with 403", async () => {
    for (const url of [
      "https://8.8.8.8/a",
      "http://2130706433/a",
      "http://0x7f000001/a",
      "http://0177.0.0.1/a",
      "http://[::ffff:127.0.0.1]/a",
      "https://[2606:4700:4700::1111]/a",
    ]) {
      expect((await serveImageProxy(request(url), "tenant")).status).toBe(403);
    }
  });
  it("refuses localhost, single labels and reserved names with 403", async () => {
    for (const url of [
      "http://localhost/a",
      "http://printer/a",
      "http://foo.localhost./a",
      "http://printer.local/a",
      "http://router.home.arpa/a",
    ]) {
      expect((await serveImageProxy(request(url), "tenant")).status).toBe(403);
    }
  });
  it("refuses DNS private IPv4 with 403 even alongside a public address", async () => {
    const fetch = network(image, ["93.184.215.14", "10.0.0.1", "172.16.0.1", "192.168.1.1"]);
    expect((await serveImageProxy(request("https://images.example.org/a"), "tenant")).status).toBe(
      403,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("refuses DNS loopback addresses with 403", async () => {
    for (const ip of ["127.0.0.1", "::1"]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });
  it("refuses DNS link-local addresses with 403", async () => {
    for (const ip of ["169.254.169.254", "fe80::1"]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });
  it("refuses DNS CGNAT addresses with 403", async () => {
    network(image, ["100.64.0.1"]);
    expect((await serveImageProxy(request("https://images.example.org/a"), "tenant")).status).toBe(
      403,
    );
  });
  it("refuses DNS multicast addresses with 403", async () => {
    for (const ip of ["224.0.0.1", "ff02::1"]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });
  it("refuses reserved, documentation, benchmark and unspecified DNS addresses with 403", async () => {
    for (const ip of [
      "0.0.0.0",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "2001:db8::1",
      "2001:2::1",
      "3fff::1",
      "100::1",
    ]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });
  it("refuses IANA-reserved gaps within global IPv6 space with 403", async () => {
    for (const ip of ["2000::1", "2001:1000::1", "2004::1", "2d00::1", "3000::1", "3ffe::1"]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });

  it("refuses unique-local and IPv4-mapped or transition IPv6 DNS addresses with 403", async () => {
    for (const ip of [
      "fc00::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::a00:1",
      "2002:7f00:1::1",
    ]) {
      network(image, [ip]);
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(403);
    }
  });
  it("refuses empty DNS answers with 403", async () => {
    network(image, []);
    expect((await serveImageProxy(request("https://images.example.org/a"), "tenant")).status).toBe(
      403,
    );
  });
  it("refuses redirects without fetching their target", async () => {
    const fetch = network(
      () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } }),
    );
    const response = await serveImageProxy(request("https://images.example.org/a"), "tenant");
    expect(response.status).toBe(403);
    expect(response.headers.has("Location")).toBe(false);
    expect(response.headers.has("X-Remit-Partition")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("refuses HTML, missing MIME and SVG with 415", async () => {
    for (const mime of ["text/html", "", "image/svg+xml; charset=utf-8"]) {
      network(() => image({ "Content-Type": mime }));
      expect(
        (await serveImageProxy(request("https://images.example.org/a"), "tenant")).status,
      ).toBe(415);
    }
  });
  it("refuses advertised oversize responses with 413", async () => {
    network(() => image({ "Content-Length": String(IMAGE_MAX_BYTES + 1) }));
    expect((await serveImageProxy(request("https://images.example.org/a"), "tenant")).status).toBe(
      413,
    );
  });
  it("terminates an oversize stream even with a lying Content-Length", async () => {
    const cancelled = vi.fn();
    network(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(IMAGE_MAX_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel: cancelled,
          }),
          { headers: { "Content-Type": "image/png", "Content-Length": "1" } },
        ),
    );
    const response = await serveImageProxy(request("https://images.example.org/a"), "tenant");
    await expect(response.arrayBuffer()).rejects.toThrow("Image stream refused");
    expect(cancelled).toHaveBeenCalled();
  });
  it("returns good images with tenant provenance and only safe response headers", async () => {
    const fetch = network(() =>
      image({
        "Set-Cookie": "tracking=1",
        "X-Remit-Partition": "forged",
        Location: "https://evil.example.org",
      }),
    );
    const response = await serveImageProxy(
      request("https://images.example.org:443/a?tracking=secret", {
        headers: {
          Cookie: "session=private",
          Authorization: "Bearer private",
          Referer: "https://private.example.org",
          "X-Custom": "private",
        },
      }),
      "server-tenant",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image bytes");
    expect(response.headers.get("X-Remit-Partition")).toBe("server-tenant");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.has("Location")).toBe(false);
    const init = fetch.mock.calls[2]?.[1];
    expect(init?.headers).toEqual({ "User-Agent": "Remit-Image-Proxy/1.0", Accept: "image/*" });
  });
  it("allows public IPv6 and HTTP port 80", async () => {
    network(image, ["2606:4700:4700::1111"]);
    const response = await serveImageProxy(request("http://images.example.org:80/a"), "tenant");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("image bytes");
  });
  it("terminates an image body that stalls after response headers", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    network(
      () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    const response = await serveImageProxy(request("https://images.example.org/a"), "tenant");
    const body = response.arrayBuffer();
    const assertion = expect(body).rejects.toThrow("Image stream refused");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("revalidates DNS before a retry and refuses a now-private destination", async () => {
    vi.useFakeTimers();
    let imageAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (new URL(String(input)).hostname === "cloudflare-dns.com") {
          return Response.json({
            Status: 0,
            Answer: [{ type: 1, data: imageAttempts ? "10.0.0.1" : "93.184.215.14" }],
          });
        }
        imageAttempts++;
        return new Response(null, { status: 503 });
      }),
    );
    const pending = serveImageProxy(request("https://images.example.org/a"), "tenant");
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(403);
    expect(imageAttempts).toBe(1);
  });

  it("logs host only and suppresses upstream errors containing a full URL", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    network(() => {
      throw new Error("https://images.example.org/private?tracking=secret");
    });
    const pending = serveImageProxy(
      request("https://images.example.org/private?tracking=secret"),
      "tenant",
    );
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(502);
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logs).toContain("images.example.org");
    expect(logs).not.toContain("tracking");
    expect(logs).not.toContain("/private");
    info.mockRestore();
    warn.mockRestore();
  });

  it("refuses methods other than GET with 405", async () => {
    expect(
      (await serveImageProxy(request("https://images.example.org/a", { method: "POST" }), "tenant"))
        .status,
    ).toBe(405);
  });
  it("backs off exponentially and stops after ten transient upstream failures", async () => {
    vi.useFakeTimers();
    const fetch = network(() => new Response(null, { status: 503 }));
    const pending = serveImageProxy(request("https://images.example.org/a"), "tenant");
    for (const delay of [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      const attempts = fetch.mock.calls.filter(
        ([input]) => new URL(String(input)).hostname === "images.example.org",
      ).length;
      await vi.advanceTimersByTimeAsync(1);
      expect(
        fetch.mock.calls.filter(
          ([input]) => new URL(String(input)).hostname === "images.example.org",
        ),
      ).toHaveLength(attempts + 1);
    }
    const response = await pending;
    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(30);
  });
  it("times out stalled upstream requests and gives up after ten attempts", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    network();
    const dnsFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).hostname === "cloudflare-dns.com") return dnsFetch(input, init);
        attempts++;
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("secret URL"))),
        );
      }),
    );
    const pending = serveImageProxy(request("https://images.example.org/a"), "tenant");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(502);
    expect(attempts).toBe(10);
  });
});

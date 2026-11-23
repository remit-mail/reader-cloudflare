import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  ACCESS_EXPIRED,
  accessFetch,
  configureAccessSession,
  renewOnce,
} from "../packages/web/src/access-session";

const PAGE = "https://app.remit.test/mail/inbox?thread=kept#message";
const RENEW = "/mail/inbox?thread=kept&reauth=1#message";
const NOW = 1_800_000_000_000;
let navigations: string[];
let events: string[];
let storage: Map<string, string>;

beforeEach(() => {
  navigations = [];
  events = [];
  storage = new Map();
  mock.method(Date, "now", () => NOW);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: PAGE,
        origin: new URL(PAGE).origin,
        replace: (url: string) => navigations.push(url),
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      dispatchEvent: (event: Event) => events.push(event.type),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  mock.restoreAll();
});

const opaqueRedirect = (): Response => {
  const response = new Response(null);
  Object.defineProperty(response, "type", { value: "opaqueredirect" });
  return response;
};

describe("live login behind an expired Access cookie", () => {
  it("installs recovery at provider configuration, before either client captures fetch", async () => {
    window.fetch = async () => opaqueRedirect();
    configureAccessSession();
    await window.fetch("/api/session");
    assert.deepEqual(navigations, [RENEW]);
    assert.deepEqual(events, [ACCESS_EXPIRED]);
  });

  for (const response of [opaqueRedirect(), new Response(null, { status: 401 })]) {
    it(`renews before the shared client can turn ${response.type}/${response.status} into signOut`, async () => {
      const transport = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Following Access to its login origin would reject with a CORS error.
        assert.equal(init?.redirect, "manual");
        assert.equal(init?.credentials, "same-origin");
        return response;
      });
      const fetch = accessFetch(transport);
      const received = await fetch("/api/config", {
        credentials: "same-origin",
        redirect: "manual",
      });
      assert.equal(received, response);
      assert.deepEqual(events, [ACCESS_EXPIRED]);
      assert.deepEqual(navigations, [RENEW]);
      assert.equal(transport.mock.callCount(), 1);
    });
  }

  it("handles generated Requests and raw content/session fetches concurrently without replaying a mutation", async () => {
    const requests: RequestInfo[] = [];
    const fetch = accessFetch(async (input) => {
      requests.push(input as RequestInfo);
      return opaqueRedirect();
    });
    const mutation = new Request("https://app.remit.test/api/threads/move", {
      method: "POST",
      body: "one move",
      headers: { "X-CSRF-Token": "unchanged" },
    });
    await Promise.all([fetch(mutation), fetch("/content/part"), fetch("/api/session")]);
    assert.deepEqual(navigations, [RENEW]);
    assert.equal(requests.length, 3);
    assert.equal(requests[0], mutation);
    assert.equal(await mutation.text(), "one move");
    assert.equal(mutation.headers.get("X-CSRF-Token"), "unchanged");
    assert.equal(renewOnce(), false);
  });

  it("leaves resource denials, throttling and server errors to their callers", async () => {
    for (const status of [200, 403, 404, 429, 500]) {
      const response = new Response(null, { status });
      assert.equal(await accessFetch(async () => response)("/api/config"), response);
    }
    assert.deepEqual(events, []);
    assert.deepEqual(navigations, []);
  });

  it("keeps connectivity failures distinct from Access expiry", async () => {
    const failure = new TypeError("Failed to fetch");
    const fetch = accessFetch(async () => {
      throw failure;
    });
    await assert.rejects(fetch("/api/config"), (error) => error === failure);
    assert.deepEqual(navigations, []);
  });

  it("does not intercept another origin, public assets or OAuth fetches", async () => {
    const transport = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.redirect, "follow");
      return new Response(null, { status: 401 });
    });
    const fetch = accessFetch(transport);
    for (const url of ["https://other.remit.test/api/config", "/sw.js", "/auth/oauth2/token"]) {
      await fetch(url, { redirect: "follow" });
    }
    assert.deepEqual(events, []);
    assert.deepEqual(navigations, []);
  });

  it("does not let a clock correction suppress renewal indefinitely", () => {
    mock.method(Date, "now", () => NOW + 120_000);
    assert.equal(renewOnce(), true);
    mock.method(Date, "now", () => NOW);
    assert.equal(renewOnce(), true);
    assert.deepEqual(navigations, [RENEW, RENEW]);
  });
});

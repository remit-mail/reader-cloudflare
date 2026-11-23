import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { verifySession } from "../packages/web/src/access-session";

describe("Access session verification", () => {
  it("uses a fresh bounded manual-redirect request and only returns the opaque partition", async () => {
    const fetch = mock.method(globalThis, "fetch", async (input, init) => {
      assert.equal(input, "/api/session");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ partitionKey: "opaque", ignored: "not identity" });
    });
    try {
      assert.deepEqual(await verifySession(), { partitionKey: "opaque" });
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
    }
  });

  for (const status of [401, 403]) {
    it(`treats ${status} as an authentication refusal`, async () => {
      const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status }));
      try {
        assert.equal(await verifySession(), null);
      } finally {
        fetch.mock.restore();
      }
    });
  }

  it("treats a manual opaque redirect as an authentication refusal", async () => {
    const response = new Response(null);
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    const fetch = mock.method(globalThis, "fetch", async () => response);
    try {
      assert.equal(await verifySession(), null);
    } finally {
      fetch.mock.restore();
    }
  });

  for (const [name, response] of [
    ["server failure", new Response(null, { status: 503 })],
    [
      "HTML login",
      new Response("<html>Cloudflare Access</html>", { headers: { "Content-Type": "text/html" } }),
    ],
    [
      "JSON served as HTML",
      new Response('{"partitionKey":"untrusted"}', { headers: { "Content-Type": "text/html" } }),
    ],
    ["invalid JSON", new Response("{", { headers: { "Content-Type": "application/json" } })],
    ["missing identity", Response.json({})],
    ["empty identity", Response.json({ partitionKey: " " })],
    ["non-string identity", Response.json({ partitionKey: 42 })],
  ] as const) {
    it(`rejects ${name} without confirming logout`, async () => {
      const fetch = mock.method(globalThis, "fetch", async () => response);
      try {
        await assert.rejects(verifySession());
      } finally {
        fetch.mock.restore();
      }
    });
  }

  it("preserves transport and timeout failures instead of treating them as logout", async () => {
    for (const error of [new TypeError("offline"), new DOMException("deadline", "TimeoutError")]) {
      const fetch = mock.method(globalThis, "fetch", async () => {
        throw error;
      });
      try {
        await assert.rejects(verifySession(), (actual) => actual === error);
      } finally {
        fetch.mock.restore();
      }
    }
  });
});

import { env as testEnv } from "cloudflare:workers";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import {
  buildBodyPartKey,
  buildExportArchiveKey,
  buildOutboxAttachmentKey,
} from "@remit/storage-service";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { r2Storage } from "../../src/api/storage";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const SUBJECT = "offline-reader-subject";
const PARTITION = deriveAccountConfigId(SUBJECT);
const TEAM = "offline-host.cloudflareaccess.test";
const AUD = "offline-host-audience";
const ORIGIN = "https://app.remit.test";
const bodyKey = buildBodyPartKey(PARTITION, "account", "message", "1.2");
let signingKey: CryptoKey;

const encoded = (value: unknown): string =>
  btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const token = async (sub = SUBJECT, extra = {}): Promise<string> => {
  const unsigned = `${encoded({ alg: "RS256", kid: "offline-key" })}.${encoded({ sub, email: "reader@remit.test", iss: `https://${TEAM}`, aud: AUD, exp: Date.now() / 1000 + 300, ...extra })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`;
};

const get = async (
  path: string,
  env: Env,
  assertion?: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (assertion !== undefined) headers.set("cf-access-jwt-assertion", assertion);
  headers.set("X-Remit-Partition", "client-forged-partition");
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
};

const workerEnv = (contentType = "text/html; charset=iso-8859-1"): Env =>
  ({
    DB: (testEnv as unknown as { DB: D1Database }).DB,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OPERATOR_EMAILS: "",
    TENANT_RATE_LIMIT: { limit: async () => ({ success: true }) },
    MAIL: {
      get: vi.fn(async () => ({
        body: "mail bytes",
        httpMetadata: { contentType },
      })),
    },
    ASSETS: { fetch: async () => new Response("shell or asset") },
  }) as unknown as Env;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
      return Response.json({ keys: [{ ...jwk, kid: "offline-key" }] });
    }),
  );
});

afterAll(() => vi.unstubAllGlobals());

describe("offline host contract", () => {
  it("returns only the derived partition with no storage calls", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("session must not touch storage");
    });
    const env = {
      ...workerEnv(),
      DB: { batch: forbidden, prepare: forbidden } as unknown as D1Database,
      TENANT_MAIL: { get: forbidden, idFromName: forbidden } as unknown as Env["TENANT_MAIL"],
    };
    const response = await get("/api/session?partitionKey=forged", env, await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Remit-Partition")).toBe(PARTITION);
    expect(await response.json()).toEqual({ partitionKey: PARTITION });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("partitions service tokens by their client id", async () => {
    const response = await get(
      "/api/session",
      workerEnv(),
      await token("", { common_name: "agent-client-id" }),
    );
    const partitionKey = deriveAccountConfigId("agent-client-id");
    expect(await response.json()).toEqual({ partitionKey });
    expect(response.headers.get("X-Remit-Partition")).toBe(partitionKey);
    expect(partitionKey).not.toBe(PARTITION);
  });

  it("refuses missing, invalid and expired Access assertions without provenance", async () => {
    for (const assertion of [undefined, "invalid", await token(SUBJECT, { exp: 1 })]) {
      for (const path of [
        "/api/session",
        `/content/${bodyKey}`,
        `/${buildExportArchiveKey(PARTITION, "job")}`,
      ]) {
        const response = await get(path, workerEnv(), assertion);
        expect(response.status).toBe(401);
        if (path === "/api/session") expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.has("X-Remit-Partition")).toBe(false);
      }
    }
  });

  it("rejects session mutations", async () => {
    const response = await get("/api/session", workerEnv(), await token(), { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("X-Remit-Partition")).toBe(false);
  });

  it("preserves part MIME, bytes and security headers regardless of authorization query", async () => {
    const env = workerEnv();
    for (const query of ["?signature=old", "?signature=renewed&partitionKey=forged"]) {
      const response = await get(`/content/${bodyKey}${query}`, env, await token());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("mail bytes");
      expect(response.headers.get("X-Remit-Partition")).toBe(PARTITION);
      expect(response.headers.get("Content-Type")).toBe("text/html; charset=iso-8859-1");
      expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline'",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(env.MAIL.get).toHaveBeenLastCalledWith(bodyKey);
    }
  });

  it("serves owned attachments and rejects other tenants before reading R2", async () => {
    const env = workerEnv("application/pdf");
    const key = buildOutboxAttachmentKey(PARTITION, "account", "draft", "attachment");
    const response = await get(`/content/${key}`, env, await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("X-Remit-Partition")).toBe(PARTITION);
    vi.mocked(env.MAIL.get).mockClear();
    const foreign = buildBodyPartKey(deriveAccountConfigId("another"), "account", "message", "1");
    const denied = await get(`/content/${foreign}?partitionKey=${PARTITION}`, env, await token());
    expect(denied.status).toBe(404);
    expect(denied.headers.has("X-Remit-Partition")).toBe(false);
    expect(env.MAIL.get).not.toHaveBeenCalled();
  });

  it("does not label rate refusals or storage failures as tenant data", async () => {
    const env = {
      ...workerEnv(),
      TENANT_RATE_LIMIT: { limit: async () => ({ success: false }) },
    };
    const refused = await get("/api/session", env, await token());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(refused.headers.has("X-Remit-Partition")).toBe(false);
    const broken = workerEnv();
    vi.mocked(broken.MAIL.get).mockRejectedValue(new Error("storage failed"));
    const failed = await get(`/content/${bodyKey}`, broken, await token());
    expect(failed.status).toBe(500);
    expect(failed.headers.has("X-Remit-Partition")).toBe(false);
  });

  it("keeps exports outside content paths and disables caching", async () => {
    const env = workerEnv();
    const key = buildExportArchiveKey(PARTITION, "job");
    const url = await r2Storage(env.MAIL, ORIGIN).getPresignedDownloadUrl(key);
    expect(url).toBe(`${ORIGIN}/${key}`);
    expect(await r2Storage(env.MAIL, ORIGIN).getPresignedDownloadUrl(bodyKey)).toBe(
      `${ORIGIN}/content/${bodyKey}`,
    );
    const response = await get(`/${key}`, env, await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain("remit-export-job.zip");
    expect(response.headers.has("X-Remit-Partition")).toBe(false);
    expect((await get(`/content/${key}`, env, await token())).status).toBe(404);
    vi.mocked(env.MAIL.get).mockClear();
    const foreign = await get(
      `/${buildExportArchiveKey(deriveAccountConfigId("another"), "job")}`,
      env,
      await token(),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("Cache-Control")).toContain("no-store");
    expect(env.MAIL.get).not.toHaveBeenCalled();
  });

  it("does not label the SPA shell with data provenance", async () => {
    const response = await get("/", workerEnv());
    expect(response.status).toBe(200);
    expect(response.headers.has("X-Remit-Partition")).toBe(false);
  });
});

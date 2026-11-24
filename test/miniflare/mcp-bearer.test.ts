import { env as testEnv } from "cloudflare:workers";
import { MCP_SCOPES } from "@remit/mcp-server/app";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { mcpAuth } from "../../src/mcp/auth";
import { serveMcpMachine } from "../../src/mcp/route";
import { verifyMcpBearer } from "../../src/mcp/verify";

const ORIGIN = "http://localhost";
const OWNER = "owner@remit.test";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const base64Url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const workerEnv = (): Env =>
  ({
    DB: (testEnv as unknown as { DB: D1Database }).DB,
    PUBLIC_ORIGIN: ORIGIN,
    ACCESS_DEV_IDENTITY: OWNER,
    MCP_AUTH_SECRET: { get: async () => "mcp-bearer-test-secret-of-at-least-32-chars" },
    LOGIN_OPERATOR: {
      isDisabled: async (email: string) => email !== OWNER,
      isOperator: async () => false,
      writeAudit: async () => undefined,
    },
  }) as unknown as Env;

const json = async (response: Response): Promise<Record<string, unknown>> => {
  expect(response.status, await response.clone().text()).toBeLessThan(400);
  return response.json();
};

describe("MCP connector token", () => {
  it("explains an invalid bearer in the response and challenge", async () => {
    const response = await serveMcpMachine(
      new Request(`${ORIGIN}/mcp`, { headers: { authorization: "Bearer invalid-token" } }),
      workerEnv(),
    );
    expect(response.status).toBe(401);
    const body = await response.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("invalid_token");
    expect(body.error_description).toMatch(/invalid|expired/i);
    expect(response.headers.get("www-authenticate")).toContain(
      `error_description="${body.error_description}"`,
    );
  });

  it("is accepted by the /mcp verifier right after it is issued", async () => {
    const env = workerEnv();
    const { auth, routes } = await mcpAuth(env);
    const browser = new Headers({ "x-dev-identity": OWNER });

    const client = await json(
      await routes.handle(
        new Request(`${ORIGIN}/auth/oauth2/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Claude",
            redirect_uris: [REDIRECT_URI],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        }),
      ),
    );
    const clientId = String(client.client_id);

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const authorize = await routes.handle(
      new Request(
        `${ORIGIN}/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: MCP_SCOPES.join(" "),
          state: "state",
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: browser },
      ),
    );
    const consentUrl = new URL(authorize.headers.get("location") ?? "", ORIGIN);
    expect(consentUrl.pathname, await authorize.text()).toBe("/consent");

    const consented = await json(
      await routes.consent(browser, {
        accept: true,
        oauth_query: consentUrl.search.slice(1),
        scope: consentUrl.searchParams.get("scope") ?? "",
      }),
    );
    const code = new URL(String(consented.url)).searchParams.get("code") ?? "";

    const token = await json(
      await routes.handle(
        new Request(`${ORIGIN}/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          }),
        }),
      ),
    );

    const verified = await verifyMcpBearer(String(token.access_token), auth, env);
    expect(verified).toMatchObject({ ok: true });
  });
});

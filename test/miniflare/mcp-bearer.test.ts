import { createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import { MCP_SCOPES } from "@remit/mcp-server/app";
import { describe, expect, it } from "vitest";
import { requireTenant } from "../../src/access";
import type { Env } from "../../src/env";
import { mcpAuth } from "../../src/mcp/auth";
import { serveMcpMachine } from "../../src/mcp/route";
import { verifyMcpBearer } from "../../src/mcp/verify";
import { OperatorSettings } from "../../src/operator-settings";
import { tenantOfFeedToken } from "../../src/tenant-directory";
import { tenantOfEmail } from "../../src/tenant-email";

const ORIGIN = "http://localhost";
const OWNER = "owner@remit.test";
const AGENT = "agent-tenant";
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
    AGENT_TENANT: AGENT,
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

const issueBearer = async (env: Env) => {
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

  return { auth, bearer: String(token.access_token) };
};

describe("MCP connector token", () => {
  it("accepts an issued token and explains refusal when the account is disabled", async () => {
    const env = workerEnv();
    const { auth, bearer } = await issueBearer(env);
    const verified = await verifyMcpBearer(bearer, auth, env);
    expect(verified).toMatchObject({ ok: true });

    env.LOGIN_OPERATOR.isDisabled = async () => true;
    const response = await serveMcpMachine(
      new Request(`${ORIGIN}/mcp`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_token",
      error_description: "The account is disabled",
    });
    expect(response.headers.get("www-authenticate")).toContain(
      'error_description="The account is disabled"',
    );
  });

  it("purges a person's credentials when they sign in again after losing their tenant_email row", async () => {
    const env = workerEnv();
    const { auth, bearer } = await issueBearer(env);
    const verified = await verifyMcpBearer(bearer, auth, env);
    if (!verified.ok) throw new Error(verified.reason);
    const { tenantId, accountConfigId } = verified.tenant;
    const db = env.DB;

    for (const [subject, feed] of [
      [tenantId, "owner-feed"],
      [AGENT, "agent-feed"],
    ] as const) {
      const account = deriveAccountConfigId(subject);
      await db.batch([
        db
          .prepare("INSERT INTO tenant_account_config (account_config_id, tenant_id) VALUES (?, ?)")
          .bind(account, subject),
        db
          .prepare(
            "INSERT INTO calendar_feed_token (feed_token_id, account_config_id, calendar_id, token_hash, created_at, updated_at) VALUES (?, ?, 'calendar', ?, 0, 0)",
          )
          .bind(feed, account, feed),
      ]);
    }
    await db
      .prepare(
        "INSERT INTO mcp_device_code (id, device_code, user_code, user_id, expires_at, status) VALUES ('device', 'device-code', 'user-code', ?, ?, 'approved')",
      )
      .bind(tenantId, Date.now() + 60_000)
      .run();
    await db.prepare("DELETE FROM tenant_email WHERE tenant_id = ?").bind(tenantId).run();

    expect(await tenantOfFeedToken(db, "owner-feed", env.AGENT_TENANT)).toBeUndefined();
    expect(await tenantOfFeedToken(db, "agent-feed", env.AGENT_TENANT)).toBe(AGENT);
    expect((await verifyMcpBearer(bearer, auth, env)).ok).toBe(false);

    await new OperatorSettings(createExecutionContext(), env).revokePersonCredentials(OWNER, false);
    expect(
      await requireTenant(new Request(ORIGIN, { headers: { "x-dev-identity": OWNER } }), env),
    ).toMatchObject({ ok: true, tenant: { tenantId } });

    expect(await tenantOfEmail(db, OWNER)).toBe(tenantId);
    expect((await verifyMcpBearer(bearer, auth, env)).ok).toBe(false);
    const remaining = await db.batch<{ count: number }>([
      ...[
        "mcp_oauth_access_token",
        "mcp_oauth_refresh_token",
        "mcp_session",
        "mcp_oauth_consent",
        "mcp_device_code",
      ].map((table) =>
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(tenantId),
      ),
      db
        .prepare("SELECT COUNT(*) AS count FROM calendar_feed_token WHERE account_config_id = ?")
        .bind(accountConfigId),
    ]);
    expect(remaining.map(({ results }) => results[0]?.count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await tenantOfFeedToken(db, "agent-feed", env.AGENT_TENANT)).toBe(AGENT);
  });
});

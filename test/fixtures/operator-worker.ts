import { DurableObject } from "cloudflare:workers";
import type { PeopleDirectory } from "@remit/auth-service/people";
import type { RemitClient } from "@remit/backend/client";
import type { UserIdentity } from "@remit/backend/serve";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import { personSettingsRoute, serveUserRequest } from "../../src/api/serve";
import type { Env } from "../../src/env";
import { isMcpMachinePath, serveMcpMachine } from "../../src/mcp/route";
import type { OperatorAuditRecord, PersonEmail } from "../../src/operator-audit-contract";
import { classificationDefaultStore } from "../../src/operator-settings";

interface TestEnv {
  readonly DB: D1Database;
  readonly MASTER_KEY: string;
  readonly TENANTS: DurableObjectNamespace<DefaultTenant>;
}

const workerEnv = (env: TestEnv): Env =>
  ({
    DB: env.DB,
    MASTER_KEY: { get: async () => env.MASTER_KEY },
  }) as Env;

const mcpEnvs = new WeakMap<TestEnv, Env>();

const mcpEnv = (env: TestEnv): Env => {
  const known = mcpEnvs.get(env);
  if (known !== undefined) return known;
  const created = {
    DB: env.DB,
    PUBLIC_ORIGIN: "http://example.test",
    MCP_AUTH_SECRET: { get: async () => "mcp-metadata-test-secret-of-at-least-32-chars" },
  } as unknown as Env;
  mcpEnvs.set(env, created);
  return created;
};

const LOGIN_PEOPLE = new Map([
  ["login-id-of-the-operator", "operator@remit.test"],
  ["login-id-of-another-operator", "other-operator@remit.test"],
  ["login-id-of-a-person", "person@remit.test"],
]);

const OPERATORS = new Set(["operator@remit.test", "other-operator@remit.test"]);

const login = {
  personEmail: async (callerEmail: string, userId: string): Promise<PersonEmail> => {
    const email = LOGIN_PEOPLE.get(userId);
    if (email === undefined || (email !== callerEmail && OPERATORS.has(email))) {
      return { ok: false, refusal: "not_found" };
    }
    return { ok: true, email };
  },
  writeAudit: async ({ actorEmail, targetEmail }: OperatorAuditRecord): Promise<void> => {
    const known = new Set(LOGIN_PEOPLE.values());
    if (!known.has(actorEmail) || !known.has(targetEmail)) {
      throw new Error("Operator audit user does not exist");
    }
  },
};

const people = {} as PeopleDirectory;

const settingsClient = (accountConfigIds: string[]) => ({
  accountSetting: { get: async () => undefined, getMany: async () => [] },
  accountConfig: { get: async () => ({ createdAt: 0 }) },
  account: {
    listAllByAccountConfig: async (accountConfigId: string) => {
      accountConfigIds.push(accountConfigId);
      return [];
    },
  },
  getClassificationDefault: async () => ({ state: "None" }),
  spam: { spamPipeline: [] },
});

export class DefaultTenant extends DurableObject<TestEnv> {
  async fetch(request: Request): Promise<Response> {
    const email = request.headers.get("x-operator") ?? "operator@remit.test";
    const identity: UserIdentity = {
      kind: "user",
      accountConfigId: "test-account-config",
      sub: request.headers.get("x-subject") ?? email,
      email,
    };
    const accountConfigIds: string[] = [];
    const client = {
      ...settingsClient(accountConfigIds),
      classificationDefault: classificationDefaultStore(workerEnv(this.env), email),
    } as unknown as RemitClient;
    const route = await personSettingsRoute(request, identity, true, this.env.DB, login);
    if (route.kind === "NotFound") return new Response(null, { status: 404 });
    const [served, targetEmail] =
      route.kind === "Person" ? [route.request, route.email] : [request, email];
    const response = await serveUserRequest(
      served,
      identity,
      true,
      client,
      "miniflare-test",
      people,
      {
        login,
        targetEmail,
      },
      deriveAccountConfigId(route.kind === "Person" ? route.tenantId : identity.sub),
    );
    const answered = new Response(response.body, response);
    answered.headers.set("x-account-config-read", accountConfigIds.join(","));
    return answered;
  }
}

export default {
  fetch(request: Request, env: TestEnv): Promise<Response> {
    if (isMcpMachinePath(new URL(request.url).pathname)) {
      return serveMcpMachine(request, mcpEnv(env));
    }
    const tenant = request.headers.get("x-tenant") ?? "one";
    return env.TENANTS.get(env.TENANTS.idFromName(tenant)).fetch(request);
  },
} satisfies ExportedHandler<TestEnv>;

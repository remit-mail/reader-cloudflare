import { DurableObject } from "cloudflare:workers";
import type { Person } from "@remit/api-openapi-types";
import type { PeopleDirectory } from "@remit/auth-service/people";
import type { RemitClient } from "@remit/backend/client";
import type { UserIdentity } from "@remit/backend/serve";
import { personSettingsRoute, serveUserRequest } from "../../src/api/serve";
import type { Env } from "../../src/env";
import { isMcpMachinePath, serveMcpMachine } from "../../src/mcp/route";
import type { OperatorAuditRecord } from "../../src/operator-audit-contract";
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

const LISTED_PERSON = { userId: "login-id-of-a-person", email: "person@remit.test" };

const LOGIN_PEOPLE = new Set(["operator@remit.test", LISTED_PERSON.email]);

const login = {
  writeAudit: async ({ actorEmail, targetEmail }: OperatorAuditRecord): Promise<void> => {
    if (!LOGIN_PEOPLE.has(actorEmail) || !LOGIN_PEOPLE.has(targetEmail)) {
      throw new Error("Operator audit user does not exist");
    }
  },
};

const listed: Person = {
  ...LISTED_PERSON,
  createdAt: 0,
  lastSignInAt: 0,
  sessionCount: 0,
  status: "Active",
  isCaller: false,
};

const people = {
  listPeople: async ({ callerId }) =>
    LOGIN_PEOPLE.has(callerId)
      ? { ok: true, value: [listed] }
      : { ok: false, refusal: "CallerDisabled" },
} as Pick<PeopleDirectory, "listPeople"> as PeopleDirectory;

const settingsClient = {
  accountSetting: { get: async () => undefined, getMany: async () => [] },
  accountConfig: { get: async () => ({ createdAt: 0 }) },
  account: { listAllByAccountConfig: async () => [] },
  getClassificationDefault: async () => ({ state: "None" }),
  spam: { spamPipeline: [] },
};

export class DefaultTenant extends DurableObject<TestEnv> {
  async fetch(request: Request): Promise<Response> {
    const email = request.headers.get("x-operator") ?? "operator@remit.test";
    const identity: UserIdentity = {
      kind: "user",
      accountConfigId: "test-account-config",
      sub: request.headers.get("x-subject") ?? email,
      email,
    };
    const client = {
      ...settingsClient,
      classificationDefault: classificationDefaultStore(workerEnv(this.env), email),
    } as unknown as RemitClient;
    const route = await personSettingsRoute(request, identity, true, this.env.DB, people);
    if (route.kind === "NotFound") return new Response(null, { status: 404 });
    const [served, targetEmail] =
      route.kind === "Person" ? [route.request, route.email] : [request, email];
    return serveUserRequest(served, identity, true, client, "miniflare-test", people, {
      login,
      targetEmail,
    });
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

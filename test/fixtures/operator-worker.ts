import { DurableObject } from "cloudflare:workers";
import type { RemitClient } from "@remit/backend/client";
import type { UserIdentity } from "@remit/backend/serve";
import { operatorAuditVia, serveRequest } from "../../src/api/serve";
import type { Env } from "../../src/env";
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

const LOGIN_PEOPLE = new Set(["operator@remit.test"]);

const login = {
  writeAudit: async ({ actorEmail, targetEmail }: OperatorAuditRecord): Promise<void> => {
    if (!LOGIN_PEOPLE.has(actorEmail) || !LOGIN_PEOPLE.has(targetEmail)) {
      throw new Error("Operator audit user does not exist");
    }
  },
};

export class DefaultTenant extends DurableObject<TestEnv> {
  fetch(request: Request): Promise<Response> {
    const email = request.headers.get("x-operator") ?? "operator@remit.test";
    const identity: UserIdentity = {
      kind: "user",
      accountConfigId: "test-account-config",
      sub: request.headers.get("x-subject") ?? email,
      email,
    };
    const client = {
      classificationDefault: classificationDefaultStore(workerEnv(this.env), email),
    } as unknown as RemitClient;
    const audit = operatorAuditVia(this.env.DB, login);
    return serveRequest(request, identity, true, client, "miniflare-test", audit, null);
  }
}

export default {
  fetch(request: Request, env: TestEnv): Promise<Response> {
    const tenant = request.headers.get("x-tenant") ?? "one";
    return env.TENANTS.get(env.TENANTS.idFromName(tenant)).fetch(request);
  },
} satisfies ExportedHandler<TestEnv>;

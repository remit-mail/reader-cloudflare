import { DurableObject } from "cloudflare:workers";
import type { RemitClient } from "@remit/backend/client";
import type { UserIdentity } from "@remit/backend/serve";
import { serveRequest } from "../../src/api/serve";
import type { Env } from "../../src/env";
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

const audit = { write: async () => undefined };

export class DefaultTenant extends DurableObject<TestEnv> {
  fetch(request: Request): Promise<Response> {
    const email = request.headers.get("x-operator") ?? "operator@remit.test";
    const identity: UserIdentity = {
      kind: "user",
      accountConfigId: "test-account-config",
      sub: email,
      email,
    };
    const client = {
      classificationDefault: classificationDefaultStore(workerEnv(this.env), email),
    } as unknown as RemitClient;
    return serveRequest(request, identity, true, client, "miniflare-test", audit);
  }
}

export default {
  fetch(request: Request, env: TestEnv): Promise<Response> {
    const tenant = request.headers.get("x-tenant") ?? "one";
    return env.TENANTS.get(env.TENANTS.idFromName(tenant)).fetch(request);
  },
} satisfies ExportedHandler<TestEnv>;

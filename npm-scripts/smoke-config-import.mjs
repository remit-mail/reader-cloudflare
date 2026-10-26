import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { base36uuidv5, REMIT_NAMESPACE } from "@remit/data-ports/id";
import { Miniflare, Response } from "miniflare";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = `${root}.tmp/smoke-bundle`;
const teamDomain = "access.smoke.test";
const audience = "smoke-audience";
const kid = "smoke-key";

const documentPath =
  process.argv[2] ?? `${root}node_modules/@remit/config-format/src/fixtures/reader-config.v1.json`;
const document = JSON.parse(readFileSync(documentPath, "utf8"));

mkdirSync(bundle, { recursive: true });
execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", bundle], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

const base64Url = (value) => Buffer.from(value).toString("base64url");
const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
const tokenFor = (sub) => {
  const claims = base64Url(
    JSON.stringify({
      sub,
      email: "smoke@example.com",
      iss: `https://${teamDomain}`,
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(privateKey).toString("base64url")}`;
};
const token = tokenFor("5f3c8e2a-9b1d-4e7f-a6c4-2d8b0e9f1a37");

const mf = new Miniflare({
  workers: [
    {
      name: "reader-cloudflare",
      modulesRoot: bundle,
      modules: [
        { type: "ESModule", path: `${bundle}/index.js` },
        ...readdirSync(bundle)
          .filter((name) => name.endsWith(".sql"))
          .map((name) => ({ type: "Text", path: `${bundle}/${name}` })),
      ],
      compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: audience,
        PUBLIC_ORIGIN: "https://smoke.test",
      },
      d1Databases: { DB: "smoke-db" },
      r2Buckets: ["MAIL"],
      queueProducers: { SYNC: { queueName: "smoke-sync" } },
      durableObjects: {
        TENANT_MAIL: { className: "TenantMailV2", useSQLite: true },
      },
      outboundService: (request) => {
        if (new URL(request.url).hostname === teamDomain) {
          return Response.json({ keys: [jwk] });
        }
        return new Response("smoke has no network", { status: 502 });
      },
    },
  ],
});

const db = await mf.getD1Database("DB");
for (const file of readdirSync(`${root}migrations`).filter((name) => name.endsWith(".sql"))) {
  const sql = readFileSync(`${root}migrations/${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await db.prepare(statement).run();
  }
}

const call = async (method, path, body, as = token) => {
  const response = await mf.dispatchFetch(`https://smoke.test${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": as, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

const counts = (report) => {
  const tally = {};
  for (const item of report.items ?? []) {
    tally[item.section] = (tally[item.section] ?? 0) + 1;
  }
  return {
    valid: report.valid,
    applied: report.applied,
    schemaVersion: report.schemaVersion,
    importId: report.importId,
    items: tally,
    errors: (report.errors ?? []).map((error) => error.code),
    warnings: (report.warnings ?? []).length,
    accountsNeedingCredentials: (report.accountsNeedingCredentials ?? []).length,
  };
};

const rows = async () => {
  const tables = ["account", "label", "filter", "account_setting", "config_import"];
  const result = {};
  for (const table of tables) {
    const row = await db.prepare(`select count(*) as n from ${table}`).first();
    result[table] = row.n;
  }
  return result;
};

const step = async (name, method, path, body) => {
  const { status, body: answer } = await call(method, path, body);
  const summary = path === "/api/config/import" && status === 200 ? counts(answer) : answer;
  console.log(JSON.stringify({ step: name, status, ...{ result: summary } }));
  return answer;
};

await step("preview", "POST", "/api/config/import", { mode: "validate", document });
await step("apply", "POST", "/api/config/import", { mode: "apply", document });
console.log(JSON.stringify({ step: "rows after apply", ...(await rows()) }));
await step("reapply without merge", "POST", "/api/config/import", { mode: "apply", document });
await step("reapply with merge", "POST", "/api/config/import", {
  mode: "apply",
  onExisting: "merge",
  document,
});
console.log(JSON.stringify({ step: "rows after reapply", ...(await rows()) }));
const config = await call("GET", "/api/config");
console.log(
  JSON.stringify({
    step: "accounts",
    status: config.status,
    userId: config.body.accountConfig?.userId,
    accounts: config.body.accounts.map((account) => ({
      email: account.email,
      connectionState: account.connectionState,
      isActive: account.isActive,
    })),
  }),
);
const exported = await call("GET", "/api/config/export");
console.log(
  JSON.stringify({
    step: "export",
    status: exported.status,
    schemaVersion: exported.body.schemaVersion,
    accounts: exported.body.document?.accounts?.length,
    labels: exported.body.document?.labels?.length,
    filters: exported.body.document?.filters?.length,
    addressFlags: exported.body.document?.addressFlags?.length,
  }),
);

const prototypeSub = "0b6f2d4e-7a1c-4e9b-8d3f-5c2a9e7b1f60";
const prototypeConfigId = "prototypeconfig0000000001";
const now = Date.now();
await db
  .prepare(
    "insert into account_config (account_config_id, user_id, state, created_at, updated_at) values (?, ?, 'active', ?, ?)",
  )
  .bind(prototypeConfigId, base36uuidv5(`user:${prototypeSub}`, REMIT_NAMESPACE), now, now)
  .run();
const prototype = await call("GET", "/api/config", undefined, tokenFor(prototypeSub));
const resolved = prototype.body.accountConfig?.accountConfigId;
console.log(JSON.stringify({ step: "prototype tenant", status: prototype.status, resolved }));
await mf.dispose();
if (resolved !== prototypeConfigId) {
  console.error(`prototype tenant resolved to ${resolved}, not ${prototypeConfigId}`);
  process.exit(1);
}

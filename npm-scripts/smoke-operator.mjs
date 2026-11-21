import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { resolveAccountId } from "./cf-api.mjs";
import { readDeploySecrets } from "./deploy-config.mjs";
import { accessEnvOf, CF_ENV, CONFIG_DIR, readEnvFile, TEST_ACCOUNT_ENV } from "./env.mjs";
import { callMcp, MCP_PROTOCOL_VERSION } from "./smoke-mcp.ts";
import { PROD } from "./stages.mjs";

const OPERATOR_TOKEN = join(CONFIG_DIR, "operator-mcp-token");
const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;

const check = (step, ok, detail) => {
  if (ok) {
    console.log(`${step}: ok`);
    return;
  }
  throw new Error(`${step}: ${detail}`);
};

const access = readEnvFile(accessEnvOf(PROD));
for (const name of ["APP_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]) {
  if (!access[name]) {
    console.error(`${accessEnvOf(PROD)} does not set ${name}; run npm run access-env:write`);
    process.exit(1);
  }
}

let operatorToken;
try {
  operatorToken = readFileSync(OPERATOR_TOKEN, "utf8").trim();
} catch {
  console.error(`${OPERATOR_TOKEN} is missing; ask the owner for an operator-granted MCP token`);
  process.exit(1);
}
if (!operatorToken) {
  console.error(`${OPERATOR_TOKEN} is empty; ask the owner for an operator-granted MCP token`);
  process.exit(1);
}

const tofuToken = process.env.CLOUDFLARE_TOFU_TOKEN;
if (!tofuToken) {
  console.error("CLOUDFLARE_TOFU_TOKEN is not set; it is required to read the deploy config key");
  process.exit(1);
}
const accountId = readEnvFile(CF_ENV).CLOUDFLARE_ACCOUNT_ID ?? (await resolveAccountId(tofuToken));
const deploySecrets = await readDeploySecrets(tofuToken, accountId);
if (!deploySecrets.classification) {
  console.error("the deploy config has no classification key");
  process.exit(1);
}

let requestId = 0;
const mcp = (path, headers, method, params) =>
  callMcp(
    new URL(path, access.APP_URL),
    {
      ...headers,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    { id: ++requestId, method, params },
  );

const operatorMcp = (method, params) =>
  mcp("/mcp", { authorization: `Bearer ${operatorToken}` }, method, params);

const agentHeaders = {
  "CF-Access-Client-Id": access.CF_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": access.CF_ACCESS_CLIENT_SECRET,
};
const agentMcp = (method, params) => mcp("/api/mcp", agentHeaders, method, params);

const callTool = async (name, args = {}) => {
  const response = await operatorMcp("tools/call", { name, arguments: args });
  const result = response.body?.result;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  check(
    name,
    response.status === 200 && result?.isError !== true && typeof text === "string",
    `answered ${response.status} without a successful tool result`,
  );
  return JSON.parse(text);
};

const callAgentTool = async (name, args = {}) => {
  const response = await agentMcp("tools/call", { name, arguments: args });
  const result = response.body?.result;
  const text = result?.content?.find((part) => part.type === "text")?.text;
  check(
    `agent ${name}`,
    response.status === 200 && result?.isError !== true && typeof text === "string",
    `answered ${response.status} without a successful tool result`,
  );
  return JSON.parse(text);
};

const appendMessage = async () => {
  const test = readEnvFile(TEST_ACCOUNT_ENV);
  for (const name of [
    "TEST_IMAP_HOST",
    "TEST_IMAP_PORT",
    "TEST_IMAP_SECURE",
    "TEST_IMAP_USER",
    "TEST_IMAP_PASSWORD",
  ]) {
    if (!test[name]) throw new Error(`${TEST_ACCOUNT_ENV} does not set ${name}`);
  }
  const now = new Date();
  const client = new ImapFlow({
    host: test.TEST_IMAP_HOST,
    port: Number(test.TEST_IMAP_PORT),
    secure: test.TEST_IMAP_SECURE === "true",
    auth: { user: test.TEST_IMAP_USER, pass: test.TEST_IMAP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    const appended = await client.append(
      "INBOX",
      [
        "From: smoke@example.invalid",
        `To: ${test.TEST_EMAIL ?? test.TEST_IMAP_USER}`,
        `Subject: operator smoke ${now.toISOString()}`,
        `Date: ${now.toUTCString()}`,
        `Message-ID: <operator-smoke-${now.getTime()}@example.invalid>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A deterministic message for the deployed classifier smoke test.",
      ].join("\r\n"),
      [],
      now,
    );
    check("append classifier fixture", appended !== false, "server returned no append result");
  } finally {
    await client.logout();
  }
};

const started = Date.now();

const initialized = await operatorMcp("initialize", {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "smoke:operator", version: "0" },
});
check(
  "operator MCP initialize",
  initialized.status === 200 && initialized.body?.result?.serverInfo !== undefined,
  `answered ${initialized.status} without server info`,
);

const configured = await callTool("get_classification_default");
check(
  "classification default from config",
  configured.source === "Config",
  `source is ${String(configured.source)}`,
);
const initialTenant = await callTool("get_tenant_settings", {
  userId: access.CF_ACCESS_CLIENT_ID,
});
const initialSources = initialTenant.classification?.sources;
check(
  "tenant classification starts inherited",
  initialSources !== undefined &&
    Object.values(initialSources).every((source) => source === "Deployment"),
  "one or more classifier settings are not inherited",
);

const classification = {
  presetId: configured.presetId,
  model: configured.model,
  baseUrl: configured.baseUrl,
  apiKey: deploySecrets.classification.api_key,
  enabled: configured.enabled,
  dailyLimit: configured.dailyLimit,
};
let defaultChanged = false;
let tenantChanged = false;
let failure;
try {
  defaultChanged = true;
  const overridden = await callTool("set_classification_default", classification);
  check(
    "classification default from operator",
    overridden.source === "Operator",
    `source is ${String(overridden.source)}`,
  );

  const statsSince = new Date().toISOString();
  await appendMessage();

  const synced = spawnSync("npm", ["run", "smoke:sync"], { stdio: "inherit" });
  if (synced.error) throw synced.error;
  check("smoke:sync", synced.status === 0, `exited ${synced.status}`);

  const statsDeadline = Date.now() + TIMEOUT_MS;
  let stats = await callAgentTool("classifier_stats", { since: statsSince });
  while (stats.examined === 0 && Date.now() < statsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    stats = await callAgentTool("classifier_stats", { since: statsSince });
  }
  check("classifier decisions", stats.examined > 0, `examined ${String(stats.examined)}`);

  tenantChanged = true;
  const saved = await callTool("update_tenant_settings", {
    userId: access.CF_ACCESS_CLIENT_ID,
    classificationPresetId: configured.presetId,
    classificationModel: configured.model,
    classificationBaseUrl: configured.baseUrl,
    classificationApiKey: deploySecrets.classification.api_key,
    classificationEnabled: configured.enabled,
    classificationDailyLimit: configured.dailyLimit,
  });
  check(
    "tenant classification key saved",
    saved.classification?.sources?.apiKey === "Saved",
    `source is ${String(saved.classification?.sources?.apiKey)}`,
  );

  const inherited = await callTool("clear_tenant_classification", {
    userId: access.CF_ACCESS_CLIENT_ID,
  });
  tenantChanged = false;
  check(
    "tenant classification key inherited",
    inherited.classification?.sources?.apiKey === "Deployment",
    `source is ${String(inherited.classification?.sources?.apiKey)}`,
  );

  const cleared = await callTool("clear_classification_default");
  defaultChanged = false;
  check(
    "classification default restored",
    cleared.source === "Config",
    `source is ${String(cleared.source)}`,
  );
} catch (error) {
  failure = error;
}
const cleanup = [
  ...(tenantChanged
    ? [callTool("clear_tenant_classification", { userId: access.CF_ACCESS_CLIENT_ID })]
    : []),
  ...(defaultChanged ? [callTool("clear_classification_default")] : []),
];
const cleanupErrors = (await Promise.allSettled(cleanup)).flatMap((result) =>
  result.status === "rejected" ? [result.reason] : [],
);
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
    failure === undefined ? "operator smoke cleanup failed" : "operator smoke and cleanup failed",
    failure === undefined ? undefined : { cause: failure },
  );
}
if (failure !== undefined) throw failure;

const agentDefault = await fetch(new URL("/api/system/classification-default", access.APP_URL), {
  headers: agentHeaders,
  redirect: "manual",
});
check(
  "agent classification default forbidden",
  agentDefault.status === 403,
  `answered ${agentDefault.status}`,
);

const agentTools = await agentMcp("tools/list");
const operatorTools = [
  "get_classification_default",
  "set_classification_default",
  "clear_classification_default",
  "get_tenant_settings",
  "update_tenant_settings",
  "clear_tenant_classification",
  "list_people",
  "invite_person",
  "revoke_invite",
  "disable_person",
  "enable_person",
  "sign_out_person",
  "reset_person_factors",
  "list_audit",
];
const agentToolNames = Array.isArray(agentTools.body?.result?.tools)
  ? agentTools.body.result.tools.map((tool) => tool.name)
  : [];
check(
  "agent has no operator tools",
  agentTools.status === 200 && operatorTools.every((name) => !agentToolNames.includes(name)),
  `answered ${agentTools.status} with an operator tool`,
);

const people = await callTool("list_people");
check("list people", Array.isArray(people.people), "did not answer with people");

await callTool("get_config");
await callTool("list_outbox_messages", { continuationToken: "" });
await callTool("list_calendars");

console.log(`smoke:operator passed in ${Date.now() - started}ms`);

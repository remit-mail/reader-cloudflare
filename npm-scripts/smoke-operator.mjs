import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAccountId } from "./cf-api.mjs";
import { readDeploySecrets } from "./deploy-config.mjs";
import { accessEnvOf, CF_ENV, CONFIG_DIR, readEnvFile } from "./env.mjs";
import { PROD } from "./stages.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const OPERATOR_TOKEN = join(CONFIG_DIR, "operator-mcp-token");

const check = (step, ok, detail) => {
  if (ok) {
    console.log(`${step}: ok`);
    return;
  }
  console.error(`${step}: ${detail}`);
  process.exit(1);
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

const cf = { ...readEnvFile(CF_ENV), ...process.env };
if (!cf.CLOUDFLARE_API_TOKEN) {
  console.error(`${CF_ENV} does not set CLOUDFLARE_API_TOKEN`);
  process.exit(1);
}
const accountId = cf.CLOUDFLARE_ACCOUNT_ID ?? (await resolveAccountId(cf.CLOUDFLARE_API_TOKEN));
const deploySecrets = await readDeploySecrets(cf.CLOUDFLARE_API_TOKEN, accountId);
if (!deploySecrets.classification) {
  console.error("the deploy config has no classification key");
  process.exit(1);
}

const parseMcpResponse = async (response) => {
  const text = await response.text();
  const data = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
    : text;
  return data === undefined || data === "" ? undefined : JSON.parse(data);
};

let requestId = 0;
const mcp = async (path, headers, method, params) => {
  const response = await fetch(new URL(path, access.APP_URL), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    redirect: "manual",
  });
  return { status: response.status, body: await parseMcpResponse(response) };
};

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

const classification = {
  presetId: configured.presetId,
  model: configured.model,
  baseUrl: configured.baseUrl,
  apiKey: deploySecrets.classification.api_key,
  enabled: configured.enabled,
  dailyLimit: configured.dailyLimit,
};
const overridden = await callTool("set_classification_default", classification);
check(
  "classification default from operator",
  overridden.source === "Operator",
  `source is ${String(overridden.source)}`,
);

const statsSince = new Date(0).toISOString();
const beforeStats = await callAgentTool("classifier_stats", { since: statsSince });

const synced = spawnSync("npm", ["run", "smoke:sync"], { stdio: "inherit" });
if (synced.error) throw synced.error;
check("smoke:sync", synced.status === 0, `exited ${synced.status}`);

const stats = await callAgentTool("classifier_stats", { since: statsSince });
check(
  "classifier decisions",
  stats.examined > beforeStats.examined,
  `examined ${String(stats.examined)}, previously ${String(beforeStats.examined)}`,
);

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
check(
  "tenant classification key inherited",
  inherited.classification?.sources?.apiKey === "Deployment",
  `source is ${String(inherited.classification?.sources?.apiKey)}`,
);

const cleared = await callTool("clear_classification_default");
check(
  "classification default restored",
  cleared.source === "Config",
  `source is ${String(cleared.source)}`,
);

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
  "list_people",
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

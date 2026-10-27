import { CF_ENV, PROJECT, readEnvFile } from "./env.mjs";

const minutes = Number(process.argv[2] ?? "15");
const needle = process.argv[3] ?? "";
const env = readEnvFile(CF_ENV);
const token = env.CLOUDFLARE_API_TOKEN;
const account = env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error(`${CF_ENV} does not set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`);
  process.exit(1);
}

const to = Date.now();
const filters = [{ key: "$metadata.service", operation: "eq", type: "string", value: PROJECT }];
if (needle !== "") {
  filters.push({ key: "$metadata.message", operation: "includes", type: "string", value: needle });
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: `${PROJECT}-logs`,
      timeframe: { from: to - minutes * 60_000, to },
      view: "events",
      limit: 2000,
      parameters: { datasets: ["cloudflare-workers"], filters },
    }),
  },
);
const payload = await response.json();
if (!response.ok || !payload.success) {
  console.error(`query failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`);
  process.exit(1);
}

const events = payload.result?.events?.events ?? [];
for (const event of events.sort((left, right) => left.timestamp - right.timestamp)) {
  const { $metadata: metadata = {}, $workers: workers = {}, ...source } = event;
  const line = {
    time: new Date(event.timestamp).toISOString(),
    outcome: workers.outcome,
    cpuMs: workers.cpuTimeMs,
    wallMs: workers.wallTimeMs,
    level: metadata.level,
    message: metadata.message,
    ...(event.source && typeof event.source === "object" ? event.source : source),
  };
  console.log(JSON.stringify(line));
}
console.error(`${events.length} events`);

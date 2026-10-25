import { CF_ENV, readEnvFile } from "./env.mjs";

const SERVICE = "reader-cloudflare";
const PREFIX = "reader-cloudflare: ";

const env = readEnvFile(CF_ENV);
const token = env.CLOUDFLARE_API_TOKEN;
const account = env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error(`${CF_ENV} does not set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`);
  process.exit(1);
}

const eq = (key, value) => ({ key, operation: "eq", type: "string", value });
const count = { operator: "count", alias: "count" };
const of = (operator, key) => ({ operator, key, keyType: "number", alias: `${operator}_${key}` });

const queries = [
  {
    name: "requests by status class",
    description: "Every HTTP response over time, split into 2xx, 3xx, 4xx and 5xx.",
    filters: [eq("event", "http.response")],
    calculations: [count],
    groupBys: ["statusClass"],
  },
  {
    name: "4xx and 5xx by route",
    description: "The 20 routes with the most error responses.",
    filters: [
      eq("event", "http.response"),
      { key: "status", operation: "gte", type: "number", value: 400 },
    ],
    calculations: [count],
    groupBys: ["route", "statusClass"],
    orderBy: "count",
    limit: 20,
  },
  {
    name: "latency by route",
    description: "p50 and p95 of durationMs per route.",
    filters: [eq("event", "http.response")],
    calculations: [of("p50", "durationMs"), of("p95", "durationMs"), count],
    groupBys: ["route"],
    orderBy: "p95_durationMs",
    limit: 20,
  },
  {
    name: "messages stored per account",
    description: "Messages stored and failed per account from queue batches.",
    filters: [eq("event", "sync.batch")],
    calculations: [of("sum", "messagesStored"), of("sum", "messagesFailed"), of("sum", "bytes")],
    groupBys: ["accountId"],
    orderBy: "sum_messagesStored",
  },
  {
    name: "sync failures per account",
    description: "Failed sync passes per account and error kind.",
    filters: [eq("event", "sync.failed")],
    calculations: [count],
    groupBys: ["accountId", "errorKind"],
    orderBy: "count",
  },
  {
    name: "queue batches and dlq",
    description: "Queue batches processed and dead-lettered messages by action.",
    filters: [{ key: "event", operation: "in", type: "string", value: "sync.batch,sync.dlq" }],
    calculations: [count, of("p95", "durationMs")],
    groupBys: ["event", "action"],
  },
  {
    name: "errors by kind",
    description: "Every line with an errorKind, by kind and event.",
    filters: [{ key: "errorKind", operation: "exists", type: "string" }],
    calculations: [count],
    groupBys: ["errorKind", "event"],
    orderBy: "count",
  },
];

const api = async (method, path, body) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/${path}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    console.error(
      `${method} ${path} failed: ${response.status} ${JSON.stringify(payload.errors ?? payload)}`,
    );
    process.exit(1);
  }
  return payload.result;
};

const toBody = (query) => ({
  name: `${PREFIX}${query.name}`,
  description: query.description,
  adhoc: false,
  parameters: {
    datasets: ["cloudflare-workers"],
    filterCombination: "and",
    filters: [eq("$metadata.service", SERVICE), ...query.filters],
    calculations: query.calculations,
    groupBys: query.groupBys.map((value) => ({ type: "string", value })),
    ...(query.orderBy === undefined ? {} : { orderBy: { value: query.orderBy, order: "desc" } }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  },
});

const existing = await api("GET", "queries?perPage=100");
const byName = new Map(existing.map((saved) => [saved.name, saved]));
for (const query of queries) {
  const body = toBody(query);
  const saved = byName.get(body.name);
  const result =
    saved === undefined
      ? await api("POST", "queries", body)
      : await api("PUT", `queries/${saved.id}`, body);
  console.log(`${saved === undefined ? "created" : "updated"} ${result.id} ${body.name}`);
}
console.log(`https://dash.cloudflare.com/${account}/workers-and-pages/observability`);

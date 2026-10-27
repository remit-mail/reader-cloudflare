import { CONSUMER_SETTINGS } from "../src/api/host-limits.ts";
import { DEAD_LETTER_SUFFIX, MAX_RETRIES } from "../src/queue/routing.ts";
import { queueFamilyOf, readJsonc, renderWrangler, WRANGLER_CONFIG } from "./wrangler-config.mjs";

const config = readJsonc(WRANGLER_CONFIG);
const families = [...Object.keys(MAX_RETRIES), DEAD_LETTER_SUFFIX];
const sample = "check-retries-sample";
const rendered = renderWrangler(
  config,
  {
    worker_name: sample,
    app_hostname: "app.example.com",
    d1_database_name: sample,
    d1_database_id: "00000000-0000-0000-0000-000000000000",
    r2_bucket_name: `${sample}-mail`,
    queues: Object.fromEntries(families.map((family) => [family, `${sample}-${family}`])),
    secrets_store_id: "0".repeat(32),
    access_aud: "0".repeat(64),
    access_team_domain: "example.cloudflareaccess.com",
  },
  { account_id: "0".repeat(32), zone_name: "example.com" },
);

const scopes = [
  ["top level", config],
  ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope]),
  ["rendered wrangler.deploy.jsonc", rendered],
];

const problems = [];
const checked = new Set();
for (const [scope, { queues }] of scopes) {
  const consumers = new Map(
    (queues?.consumers ?? []).map((entry) => [queueFamilyOf(entry.queue), entry]),
  );
  const deadLetter = consumers.get(DEAD_LETTER_SUFFIX)?.queue;
  if (deadLetter === undefined)
    problems.push(`${scope}: no consumer for a *-${DEAD_LETTER_SUFFIX} queue`);
  for (const family of Object.keys(MAX_RETRIES)) {
    checked.add(family);
    const consumer = consumers.get(family);
    if (consumer === undefined) {
      problems.push(`${scope}: no consumer for a *-${family} queue`);
      continue;
    }
    const { queue } = consumer;
    if (consumer.max_retries !== MAX_RETRIES[family]) {
      problems.push(
        `${scope}: ${queue} has max_retries ${consumer.max_retries}, MAX_RETRIES.${family} in src/queue/routing.ts is ${MAX_RETRIES[family]}`,
      );
    }
    const settings = CONSUMER_SETTINGS[family];
    if (consumer.max_batch_size !== settings.maxBatchSize) {
      problems.push(
        `${scope}: ${queue} has max_batch_size ${consumer.max_batch_size}, CONSUMER_SETTINGS.${family} in src/api/host-limits.ts is ${settings.maxBatchSize}`,
      );
    }
    const concurrency = consumer.max_concurrency ?? "Auto";
    if (concurrency !== settings.maxConcurrency) {
      problems.push(
        `${scope}: ${queue} has max_concurrency ${concurrency}, CONSUMER_SETTINGS.${family} in src/api/host-limits.ts is ${settings.maxConcurrency}`,
      );
    }
    if (consumer.dead_letter_queue !== deadLetter) {
      problems.push(
        `${scope}: ${queue} dead-letters to ${consumer.dead_letter_queue}, not ${deadLetter}`,
      );
    }
  }
  for (const [family, { queue }] of consumers) {
    if (!families.includes(family)) {
      problems.push(`${scope}: ${queue} has a consumer but no family in src/queue/routing.ts`);
    }
  }
}
for (const { queue } of [...rendered.queues.producers, ...rendered.queues.consumers]) {
  if (!queue.startsWith(`${sample}-`))
    problems.push(`rendered wrangler.deploy.jsonc keeps ${queue}`);
}
for (const family of Object.keys(MAX_RETRIES)) {
  if (!checked.has(family)) problems.push(`MAX_RETRIES.${family} names no queue to check`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check:retries: ${problem}`);
  process.exit(1);
}
console.log(
  `check:retries: ${scopes.length} scopes agree with MAX_RETRIES, CONSUMER_SETTINGS and one shared dead-letter queue`,
);

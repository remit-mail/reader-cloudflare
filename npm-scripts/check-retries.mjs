import { CONSUMER_SETTINGS } from "../src/api/host-limits.ts";
import { DEAD_LETTER_SUFFIX, MAX_RETRIES, queueFamilyOf } from "../src/queue/routing.ts";
import { readJsonc, WRANGLER_CONFIG } from "./wrangler-config.mjs";

const config = readJsonc(WRANGLER_CONFIG);
const families = [...Object.keys(MAX_RETRIES), DEAD_LETTER_SUFFIX];
const scopes = [
  ["top level", config],
  ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope]),
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
    if (consumer.max_batch_timeout !== settings.maxBatchTimeoutSeconds) {
      problems.push(
        `${scope}: ${queue} has max_batch_timeout ${consumer.max_batch_timeout}, CONSUMER_SETTINGS.${family} in src/api/host-limits.ts is ${settings.maxBatchTimeoutSeconds}`,
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONSUMER_SETTINGS } from "../src/api/host-limits.ts";
import { CONSUMED_QUEUES, MAX_RETRIES, SHARED_DLQ } from "../src/queue/routing.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

const stripJsonc = (text) => {
  let out = "";
  let inString = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    const next = text[at + 1];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++at] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (at < text.length && text[at] !== "\n") at++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      at = text.indexOf("*/", at + 2) + 1;
      if (at === 0) throw new Error("wrangler.jsonc has an unterminated block comment");
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};

const config = JSON.parse(stripJsonc(readFileSync(`${root}wrangler.jsonc`, "utf8")));

const scopes = [
  ["top level", config],
  ...Object.entries(config.env ?? {}).map(([name, scope]) => [`env.${name}`, scope]),
];

const problems = [];
const checked = new Set();
for (const [scope, { queues }] of scopes) {
  const consumers = new Map((queues?.consumers ?? []).map((entry) => [entry.queue, entry]));
  for (const [queue, family] of Object.entries(CONSUMED_QUEUES)) {
    checked.add(family);
    const consumer = consumers.get(queue);
    if (consumer === undefined) {
      problems.push(`${scope}: no consumer for ${queue}`);
      continue;
    }
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
    if (consumer.dead_letter_queue !== SHARED_DLQ) {
      problems.push(
        `${scope}: ${queue} dead-letters to ${consumer.dead_letter_queue}, not ${SHARED_DLQ}`,
      );
    }
  }
  for (const queue of consumers.keys()) {
    if (queue !== SHARED_DLQ && !Object.hasOwn(CONSUMED_QUEUES, queue)) {
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
  `check:retries: ${scopes.length} scopes agree with MAX_RETRIES, CONSUMER_SETTINGS and ${SHARED_DLQ}`,
);

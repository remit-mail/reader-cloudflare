import { execute } from "./backfill-tenant-account-config.mjs";
import { wrangler, wranglerOutput } from "./cf.mjs";
import { cfApi } from "./cf-api.mjs";

const USER_TABLES =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 4) <> '_cf_' AND name <> 'd1_migrations'";

export const scriptExists = async (token, accountId, name) =>
  (await cfApi(token, "GET", `/accounts/${accountId}/workers/scripts`)).some(
    (script) => script.id === name,
  );

export const removeStrayConsumers = async (token, accountId, outputs) => {
  const stageQueues = new Set(Object.values(outputs.queues));
  const queues = await cfApi(token, "GET", `/accounts/${accountId}/queues?per_page=100`);
  for (const queue of queues.filter(({ queue_name }) => stageQueues.has(queue_name))) {
    for (const consumer of queue.consumers ?? []) {
      if (consumer.type !== "worker" || consumer.script === outputs.worker_name) continue;
      console.log(`reclaim: detaching ${consumer.script} from ${queue.queue_name}`);
      await cfApi(
        token,
        "DELETE",
        `/accounts/${accountId}/queues/${queue.queue_id}/consumers/${consumer.consumer_id}`,
      );
    }
  }
};

export const emptyDatabase = (config, database, env) => {
  const [result] = JSON.parse(
    wranglerOutput([...execute(config, database, USER_TABLES), "--json"], env),
  );
  const tables = result.results.map((row) => row.name);
  console.log(`reclaim: emptying ${tables.length} table(s) in ${database}`);
  if (tables.length === 0) return 0;
  const sql = tables.map((table) => `DELETE FROM \`${table}\`;`).join(" ");
  return wrangler(execute(config, database, sql), env);
};

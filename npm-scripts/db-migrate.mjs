import { fileURLToPath } from "node:url";
import { wrangler, wranglerOutput } from "./cf.mjs";
import { rekeyAppDb } from "./rekey-app-db.mjs";

const DATABASE = "reader-cloudflare";

const remoteQuery = async (sql) => {
  const [result] = JSON.parse(
    wranglerOutput(["d1", "execute", DATABASE, "--remote", "--json", "--command", sql]),
  );
  return result?.results ?? [];
};

export const migrate = async () => {
  const applied = wrangler(["d1", "migrations", "apply", DATABASE, "--remote"]);
  if (applied !== 0) return applied;
  await rekeyAppDb(remoteQuery);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await migrate());

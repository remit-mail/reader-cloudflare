import { fileURLToPath } from "node:url";
import { wrangler } from "./cf.mjs";
import { CF_BOOTSTRAP_ENV } from "./env.mjs";

const DATABASE = "reader-cloudflare";

export const migrate = async () =>
  wrangler(["d1", "migrations", "apply", DATABASE, "--remote"], CF_BOOTSTRAP_ENV);

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await migrate());

import { fileURLToPath } from "node:url";
import { wrangler } from "./cf.mjs";

const DATABASE = "reader-cloudflare";

export const migrate = async () => wrangler(["d1", "migrations", "apply", DATABASE, "--remote"]);

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await migrate());

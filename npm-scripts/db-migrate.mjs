import { fileURLToPath } from "node:url";
import { wrangler } from "./cf.mjs";

export const migrate = () =>
  wrangler(["d1", "migrations", "apply", "reader-cloudflare", "--remote"]);

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(migrate());

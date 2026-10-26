import { fileURLToPath } from "node:url";
import { inWorkersBuilds, wrangler } from "./cf.mjs";

const DATABASE = "reader-cloudflare";

export const migrate = async () => wrangler(["d1", "migrations", "apply", DATABASE, "--remote"]);

const buildStep = process.argv.includes("--build");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (buildStep && !inWorkersBuilds) process.exit(0);
  process.exit(await migrate());
}

import { chmodSync, existsSync, renameSync } from "node:fs";
import { CF_BOOTSTRAP_ENV, CF_ENV } from "./env.mjs";

if (existsSync(CF_BOOTSTRAP_ENV)) {
  console.log("already present");
  process.exit(0);
}
if (!existsSync(CF_ENV)) {
  console.error(`neither ${CF_BOOTSTRAP_ENV} nor ${CF_ENV} exists`);
  process.exit(1);
}
renameSync(CF_ENV, CF_BOOTSTRAP_ENV);
chmodSync(CF_BOOTSTRAP_ENV, 0o600);
console.log("moved");

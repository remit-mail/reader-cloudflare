import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const commit =
  process.env.WORKERS_CI_COMMIT_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

writeFileSync(
  new URL("../src/commit.ts", import.meta.url),
  `export const commit = ${JSON.stringify(commit)};\n`,
);

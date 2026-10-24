import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const commit =
  process.env.WORKERS_CI_COMMIT_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const target = new URL("../src/commit.ts", import.meta.url);
const source = `export const commit = ${JSON.stringify(commit)};\n`;

if (!existsSync(target) || readFileSync(target, "utf8") !== source) writeFileSync(target, source);

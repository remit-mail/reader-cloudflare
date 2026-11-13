import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const stamp = Math.floor(Date.now() / 1000);
const branch = `retry/${stamp}`;
const worktree = join(homedir(), "development", "reader-cloudflare-worktrees", `retry-${stamp}`);

run("git", ["fetch", "origin"]);
const sha = run("git", ["rev-parse", "--short", "origin/main"]);
const subject = `chore(deploy): retry the workers build of ${sha}`;
const body = [
  "What: an empty commit so Workers Builds rebuilds `main`.",
  `Why: the previous build of ${sha} failed on a transient Cloudflare error.`,
  "How: squash auto-merge once `ci` is green.",
  "Issue: none.",
].join("\n");

run("git", ["worktree", "add", worktree, "-b", branch, "origin/main"]);
run("git", ["commit", "--allow-empty", "-m", subject], worktree);
run("git", ["push", "-u", "origin", branch], worktree);
const url = run(
  "gh",
  ["pr", "create", "--base", "main", "--head", branch, "--title", subject, "--body", body],
  worktree,
);
run("gh", ["pr", "merge", url, "--squash", "--auto"], worktree);
run("git", ["worktree", "remove", worktree]);
run("git", ["branch", "-D", branch]);
console.log(url);

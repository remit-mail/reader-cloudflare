import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DOTFILES = join(homedir(), "development", "dotfiles");
const SCRATCH = join(homedir(), "development", ".tmp");

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error?.code === "ENOENT") {
    console.error(`${command} is not on PATH; it is needed to sync secrets with ${DOTFILES}`);
    process.exit(1);
  }
  if (result.error) throw result.error;
  return result;
};

const fail = (command, args, result) => {
  console.error(`${command} ${args.join(" ")} exited with ${result.status}`);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
};

const must = (command, args) => {
  const result = run(command, args);
  if (result.status !== 0) fail(command, args, result);
  return result;
};

const git = (...args) => ["-C", DOTFILES, ...args];

const storedEquals = (name, path) => {
  if (!existsSync(join(DOTFILES, "secrets", `${name}.age`))) return false;
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "dotfiles-secret-"));
  const plain = join(dir, name);
  const result = run("dotfiles-key", ["decrypt", name, "-o", plain]);
  const same = result.status === 0 && readFileSync(plain).equals(readFileSync(path));
  rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0) fail("dotfiles-key", ["decrypt", name], result);
  return same;
};

export const restoreSecret = (name, path, label) => {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  must("dotfiles-key", ["decrypt", name, "-o", path]);
  console.log(`${label} restored from dotfiles`);
};

export const pushSecret = (name, path, label, message) => {
  if (storedEquals(name, path)) {
    console.log(`${label} unchanged`);
    return;
  }
  const file = join("secrets", `${name}.age`);
  must("dotfiles-key", ["encrypt", name, path]);
  must("git", git("add", file));
  must("git", git("commit", "-q", "-m", message, "--", file));
  const push = run("git", git("push", "-q"));
  if (push.status !== 0) {
    if (!/non-fast-forward|fetch first|rejected/.test(push.stderr)) fail("git", ["push"], push);
    must("git", git("pull", "-q", "--rebase", "--autostash"));
    must("git", git("push", "-q"));
  }
  console.log(`${label} pushed to dotfiles`);
};

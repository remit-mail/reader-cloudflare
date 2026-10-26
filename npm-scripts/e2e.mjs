import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env.mjs";

const READER_REPO = "https://github.com/remit-mail/reader.git";
const READER_REF = "699a1115a8d8a855aaefb905bb4eddca8cc73dd6";
const READER_PATHS = [
  "deploy/vps/docker-compose.dovecot.yml",
  "deploy/vps/e2e.env",
  "docker/test/",
  "packages/e2e/src/",
];
const MASTER_KEY_STORE = "0376668ade8548e5a44a2d63d0a7f537";
const READY_TIMEOUT_MS = 180_000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = join(root, "e2e");
const readerDir = join(e2eDir, ".reader");
const bin = (name) => join(root, "node_modules", ".bin", name);

const slot = (
  process.env.E2E_SLOT ?? `wt-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`
)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 40);
const project = `rcf-e2e-${slot}`;
const stateDir = join(root, ".tmp", "e2e", slot);
const wranglerLog = join(stateDir, "wrangler.log");

const onPath = (name) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

const capped = onPath("cap");
const withCap = (command, args) => (capped ? ["cap", [command, ...args]] : [command, args]);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
};

const output = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: root, encoding: "utf8", ...options }).stdout?.trim() ?? "";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const fetchReader = () => {
  const git = (...args) => run("git", ["-C", readerDir, ...args]);
  if (
    existsSync(join(readerDir, ".git")) &&
    output("git", ["-C", readerDir, "rev-parse", "HEAD"]) === READER_REF
  ) {
    return;
  }
  rmSync(readerDir, { recursive: true, force: true });
  mkdirSync(readerDir, { recursive: true });
  git("init", "--quiet");
  git("remote", "add", "origin", READER_REPO);
  git("sparse-checkout", "set", "--no-cone", ...READER_PATHS);
  git("fetch", "--quiet", "--depth", "1", "origin", READER_REF);
  git("checkout", "--quiet", "FETCH_HEAD");
};

const waitForReady = async (url, wrangler) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null)
      throw new Error(`wrangler dev exited with ${wrangler.exitCode}`);
    const ready = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`wrangler dev was not ready at ${url} within ${READY_TIMEOUT_MS}ms`);
};

const matching = (marker) => output("pgrep", ["-f", "--", marker]).split(/\s+/).filter(Boolean);

const processGroups = (pids) =>
  pids.length === 0
    ? []
    : output("ps", ["-o", "pgid=", "-p", pids.join(",")])
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);

const signalGroups = (groups, signal) => {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};

const stop = async (child, marker) => {
  const groups = new Set([child.pid, ...processGroups(matching(marker))]);
  signalGroups(groups, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (matching(marker).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  signalGroups(new Set([...groups, ...processGroups(matching(marker))]), "SIGKILL");
};

const main = async () => {
  const started = Date.now();
  fetchReader();
  const readerEnv = readEnvFile(join(readerDir, "deploy/vps/e2e.env"));
  const [
    workerPort,
    inspectorPort,
    imapPort,
    smtpPort,
    smtpHttpPort,
    rejectingSmtpPort,
    rejectingSmtpHttpPort,
  ] = await Promise.all(Array.from({ length: 7 }, freePort));
  const commit = output("git", ["rev-parse", "HEAD"]);
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    E2E_COMMIT: commit,
    E2E_BASE_URL: `http://127.0.0.1:${workerPort}`,
    E2E_HTTP_PORT: String(workerPort),
    E2E_IMAP_HOST: "127.0.0.1",
    E2E_IMAP_PORT: String(imapPort),
    E2E_IMAP_STACK_PORT: String(imapPort),
    E2E_IMAP_PASSWORD: readerEnv.E2E_IMAP_PASSWORD,
    E2E_IMAP_NAMED_TRASH_HOST: "127.0.0.1",
    E2E_IMAP_NAMED_TRASH_PORT: String(imapPort),
    E2E_SMTP_HOST: "127.0.0.1",
    E2E_SMTP_PORT: String(smtpPort),
    E2E_SMTP_STACK_PORT: String(smtpPort),
    E2E_SMTP_HTTP_PORT: String(smtpHttpPort),
    E2E_SMTP_REJECT_HOST: "127.0.0.1",
    E2E_SMTP_REJECT_PORT: String(rejectingSmtpPort),
    E2E_SMTP_REJECT_STACK_PORT: String(rejectingSmtpPort),
    E2E_SMTP_REJECT_HTTP_PORT: String(rejectingSmtpHttpPort),
    E2E_SMTP_REJECT_ALLOWED_RECIPIENTS: readerEnv.E2E_SMTP_REJECT_ALLOWED_RECIPIENTS,
    E2E_QUEUE_PORT: "0",
    E2E_WRANGLER_LOG: wranglerLog,
  };
  const compose = (...args) =>
    run("docker", ["compose", "-p", project, "-f", join(e2eDir, "compose.yml"), ...args], {
      env,
    });

  console.log(`e2e: slot ${slot}, project ${project}, worker on ${env.E2E_BASE_URL}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  let wrangler;
  let log;
  try {
    compose("up", "--detach", "--wait", "dovecot", "mailpit", "mailpit-rejecting");
    run(...withCap("npm", ["run", "build"]), { env });
    run(
      bin("wrangler"),
      [
        "d1",
        "migrations",
        "apply",
        "reader-cloudflare",
        "--local",
        "--env",
        "e2e",
        "--persist-to",
        stateDir,
      ],
      { env },
    );
    run(
      bin("wrangler"),
      [
        "secrets-store",
        "secret",
        "create",
        MASTER_KEY_STORE,
        "--name",
        "MASTER_KEY",
        "--scopes",
        "workers",
        "--value",
        randomBytes(32).toString("base64"),
        "--persist-to",
        stateDir,
      ],
      { env },
    );
    log = openSync(wranglerLog, "w");
    const [command, args] = withCap(bin("wrangler"), [
      "dev",
      "--env",
      "e2e",
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      stateDir,
      "--var",
      `PUBLIC_ORIGIN:${env.E2E_BASE_URL}`,
      "--show-interactive-dev-session=false",
      "--test-scheduled",
    ]);
    wrangler = spawn(command, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    await waitForReady(`${env.E2E_BASE_URL}/`, wrangler);
    run(
      ...withCap(bin("playwright"), [
        "test",
        "-c",
        join(e2eDir, "playwright.config.ts"),
        "--workers",
        "1",
      ]),
      { env },
    );
    console.log(`e2e: passed in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    if (wrangler !== undefined) await stop(wrangler, `--inspector-port ${inspectorPort}`);
    if (log !== undefined) closeSync(log);
    compose("down", "--volumes", "--remove-orphans");
    console.log(`e2e: wrangler log at ${wranglerLog}`);
  }
};

main().catch((error) => {
  console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

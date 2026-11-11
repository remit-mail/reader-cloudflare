import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env.mjs";

const READER_REPO = "https://github.com/remit-mail/reader.git";
const READER_REF = "518d0c0cdcb322f615fdd419c490c71479d824f0";
const READER_PATHS = [
  "deploy/vps/docker-compose.dovecot.yml",
  "deploy/vps/e2e.env",
  "docker/test/",
  "packages/e2e/src/",
];
const MASTER_KEY_STORE = "00000000000000000000000000000000";
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

// Playwright runs async so the event loop stays free for the control server.
const runAsync = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (status) =>
      status === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${status}`)),
    );
  });

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

// A spec restarts `wrangler dev` through this loopback server to evict every
// Durable Object mid-run; the restart keeps the same --persist-to and ports.
const serveControl = (port, restartWrangler) =>
  new Promise((resolve, reject) => {
    let restarting = Promise.resolve();
    const server = createHttpServer((request, response) => {
      const reply = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method !== "POST" || request.url !== "/wrangler/restart") {
        return reply(404, { error: `no ${request.method} ${request.url}` });
      }
      const started = Date.now();
      restarting = restarting.then(restartWrangler).then(
        () => reply(200, { restartedInMs: Date.now() - started }),
        (error) => reply(500, { error: error instanceof Error ? error.message : String(error) }),
      );
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

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
    microsoftPort,
    xoauth2ImapPort,
    xoauth2SmtpPort,
    faultImapPort,
    faultControlPort,
    faultSmtpPort,
    faultSmtpControlPort,
    harnessControlPort,
  ] = await Promise.all(Array.from({ length: 15 }, freePort));
  const commit = output("git", ["rev-parse", "HEAD"]);
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    VITE_LOGIN_ORIGIN: "http://127.0.0.1:8791",
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
    E2E_MSOAUTH_TOKEN_PORT: String(microsoftPort),
    E2E_XOAUTH2_IMAP_PORT: String(xoauth2ImapPort),
    E2E_XOAUTH2_SMTP_PORT: String(xoauth2SmtpPort),
    E2E_FAULT_IMAP_PORT: String(faultImapPort),
    E2E_FAULT_CONTROL_PORT: String(faultControlPort),
    E2E_FAULT_SMTP_PORT: String(faultSmtpPort),
    E2E_FAULT_SMTP_CONTROL_PORT: String(faultSmtpControlPort),
    E2E_HARNESS_CONTROL_PORT: String(harnessControlPort),
    E2E_QUEUE_PORT: "0",
    E2E_WRANGLER_LOG: wranglerLog,
  };
  const shimServer = (port) => ({ host: "127.0.0.1", port, tls: false, startTls: false });
  const msOAuthOverrides = {
    tokenEndpoint: `http://127.0.0.1:${microsoftPort}/token`,
    imapServer: shimServer(xoauth2ImapPort),
    smtpServer: shimServer(xoauth2SmtpPort),
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
  let control;
  let xoauth2;
  const faultProxies = [];
  try {
    compose(
      "up",
      "--detach",
      "--wait",
      "dovecot",
      "mailpit",
      "mailpit-rejecting",
      "fake-microsoft",
    );
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
    const createLocalSecret = (name, value) =>
      run(
        bin("wrangler"),
        [
          "secrets-store",
          "secret",
          "create",
          MASTER_KEY_STORE,
          "--name",
          name,
          "--scopes",
          "workers",
          "--value",
          value,
          "--persist-to",
          stateDir,
        ],
        { env },
      );
    createLocalSecret("MASTER_KEY", randomBytes(32).toString("base64"));
    createLocalSecret("MSOAUTH_CLIENT_SECRET", readerEnv.MSOAUTH_CLIENT_SECRET);
    createLocalSecret("MCP_AUTH_SECRET", randomBytes(32).toString("base64"));
    xoauth2 = spawn(process.execPath, [join(e2eDir, "xoauth2-shim.mjs")], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    for (const ports of [
      [faultImapPort, imapPort, faultControlPort],
      [faultSmtpPort, smtpPort, faultSmtpControlPort],
    ]) {
      faultProxies.push(
        spawn(process.execPath, [join(e2eDir, "fault-proxy.mjs"), ...ports.map(String)], {
          cwd: root,
          env,
          stdio: "inherit",
        }),
      );
    }
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
      "--var",
      `MSOAUTH_CLIENT_ID:${readerEnv.MSOAUTH_CLIENT_ID}`,
      "--var",
      `MSOAUTH_OVERRIDES:${JSON.stringify(msOAuthOverrides)}`,
      "--show-interactive-dev-session=false",
      "--test-scheduled",
    ]);
    const startWrangler = async () => {
      wrangler = spawn(command, args, {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", log, log],
      });
      await waitForReady(`${env.E2E_BASE_URL}/`, wrangler);
    };
    await startWrangler();
    control = await serveControl(harnessControlPort, async () => {
      await stop(wrangler, `--inspector-port ${inspectorPort}`);
      await startWrangler();
    });
    await runAsync(
      ...withCap(bin("playwright"), [
        "test",
        "-c",
        join(e2eDir, "playwright.config.ts"),
        "--workers",
        "1",
        ...process.argv.slice(2),
      ]),
      { env },
    );
    console.log(`e2e: passed in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    control?.close();
    if (wrangler !== undefined) await stop(wrangler, `--inspector-port ${inspectorPort}`);
    if (log !== undefined) closeSync(log);
    xoauth2?.kill();
    for (const proxy of faultProxies) proxy.kill();
    compose("down", "--volumes", "--remove-orphans");
    console.log(`e2e: wrangler log at ${wranglerLog}`);
  }
};

main().catch((error) => {
  console.error(`e2e: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { oauthClientUpsertSql } from "./oauth-client.mjs";

const SECRETS_STORE = "00000000000000000000000000000000";
const CLIENT_ID = "reader-cloudflare-access";
const READY_TIMEOUT_MS = 180_000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loginConfig = join(root, "packages", "login", "wrangler.jsonc");
const bin = (name) => join(root, "node_modules", ".bin", name);

const slot = (
  process.env.E2E_SLOT ?? `wt-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`
)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .slice(0, 40);
const stateDir = join(root, ".tmp", "e2e-login", slot);
const wranglerLog = join(stateDir, "wrangler.log");

const capped =
  spawnSync("sh", ["-c", "command -v cap"], { encoding: "utf8" }).stdout.trim().length > 0;
const withCap = (command, args) => (capped ? ["cap", [command, ...args]] : [command, args]);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
};

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const waitForReady = async (url, child) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}`);
    const ready = await fetch(url, { redirect: "manual" }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`wrangler dev was not ready at ${url} within ${READY_TIMEOUT_MS}ms`);
};

const stop = async (child) => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return;
  }
  const deadline = Date.now() + 10_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const main = async () => {
  const started = Date.now();
  const [loginPort, inspectorPort, callbackPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const loginOrigin = `http://127.0.0.1:${loginPort}`;
  const callbackOrigin = `http://127.0.0.1:${callbackPort}`;
  const clientSecret = randomBytes(32).toString("base64url");
  const env = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    E2E_LOGIN_BASE_URL: loginOrigin,
    E2E_LOGIN_CALLBACK_PORT: String(callbackPort),
    E2E_LOGIN_REDIRECT_URI: `${callbackOrigin}/cdn-cgi/access/callback`,
    E2E_LOGIN_CLIENT_ID: CLIENT_ID,
    E2E_LOGIN_CLIENT_SECRET: clientSecret,
    E2E_LOGIN_WRANGLER_LOG: wranglerLog,
  };
  const wranglerLocal = (...args) =>
    run(
      bin("wrangler"),
      [...args, "--local", "--env", "e2e", "--config", loginConfig, "--persist-to", stateDir],
      { env },
    );

  console.log(`e2e:login: slot ${slot}, login worker on ${loginOrigin}`);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  let wrangler;
  let log;
  try {
    run(...withCap("npm", ["run", "build:schema"]), { env });
    wranglerLocal("d1", "migrations", "apply", "reader-cloudflare-login");
    wranglerLocal(
      "d1",
      "execute",
      "reader-cloudflare-login",
      "--command",
      oauthClientUpsertSql({
        clientId: CLIENT_ID,
        secretHash: createHash("sha256").update(clientSecret).digest("base64url"),
        redirectUri: env.E2E_LOGIN_REDIRECT_URI,
        now: Date.now(),
      }),
    );
    run(
      bin("wrangler"),
      [
        "secrets-store",
        "secret",
        "create",
        SECRETS_STORE,
        "--name",
        "LOGIN_AUTH_SECRET",
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
      "--config",
      loginConfig,
      "--env",
      "e2e",
      "--ip",
      "127.0.0.1",
      "--port",
      String(loginPort),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      stateDir,
      "--var",
      `LOGIN_ORIGIN:${loginOrigin}`,
      "--var",
      `READER_ORIGIN:${callbackOrigin}`,
      "--show-interactive-dev-session=false",
      "--test-scheduled",
    ]);
    wrangler = spawn(command, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    await waitForReady(`${loginOrigin}/sign-in`, wrangler);
    await runAsync(
      ...withCap(bin("playwright"), [
        "test",
        "-c",
        join(root, "e2e", "login.playwright.config.ts"),
        "--workers",
        "1",
        ...process.argv.slice(2),
      ]),
      { env },
    );
    console.log(`e2e:login: passed in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    if (wrangler !== undefined) await stop(wrangler);
    if (log !== undefined) closeSync(log);
    console.log(`e2e:login: wrangler log at ${wranglerLog}`);
  }
};

main().catch((error) => {
  console.error(`e2e:login: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

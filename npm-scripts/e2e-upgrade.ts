import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { readJsonc } from "./wrangler-config.mjs";

// Pass an installed checkout of the baseline. Both apps use the real Worker
// and built SW; the proxy keeps the browser origin and durable profile intact.
const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: npm run e2e:upgrade -- <installed baseline checkout>");
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".tmp", "upgrade");
mkdirSync(output, { recursive: true });
const sha = (cwd: string) => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const run = async (command: string, args: string[], cwd = root, env = process.env) => {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} exited ${code}`);
};
const workers = [];
let activePort = 8792;
const proxy = createServer((incoming, outgoing) => {
  if (incoming.method === "POST" && incoming.url === "/__e2e/upgrade") {
    activePort = 8793;
    outgoing.end();
    return;
  }
  const forwarded = request(
    {
      hostname: "127.0.0.1",
      port: activePort,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  incoming.pipe(forwarded);
});
try {
  for (const [checkout, port] of [
    [resolve(baseline), 8792],
    [root, 8793],
  ] as const) {
    await run("npm", ["run", "build"], checkout);
    const portable = readJsonc(join(checkout, "wrangler.jsonc"));
    const config = { ...portable, ...portable.env.e2e };
    delete config.env;
    delete config.build;
    config.main = join(checkout, "src/index.ts");
    config.assets.directory = join(checkout, "packages/web/dist");
    config.alias = Object.fromEntries(
      Object.entries<string>(portable.alias).map(([name, path]) => [name, resolve(checkout, path)]),
    );
    const configPath = join(output, `${port}.json`);
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(join(output, `${port}.log`), "w");
    const child = spawn(
      join(root, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--config",
        configPath,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(port + 1000),
      ],
      { cwd: checkout, detached: true, stdio: ["ignore", log, log] },
    );
    closeSync(log);
    workers.push(child);
    const deadline = Date.now() + 60_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Worker ${port} exited ${child.exitCode}`);
      if (
        await fetch(`http://127.0.0.1:${port}/`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      if (Date.now() > deadline) throw new Error(`Worker ${port} did not start`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  proxy.listen(8790, "127.0.0.1");
  await once(proxy, "listening");
  await run(
    join(root, "node_modules/.bin/playwright"),
    ["test", "-c", "e2e/playwright.config.ts", "pwa-upgrade.spec.ts"],
    root,
    {
      ...process.env,
      E2E_BASE_URL: "http://127.0.0.1:8790",
      E2E_COMMIT: sha(root),
      E2E_UPGRADE_FROM_COMMIT: sha(resolve(baseline)),
      E2E_UPGRADE_CONTROL: "http://127.0.0.1:8790/__e2e/upgrade",
    },
  );
} finally {
  proxy.closeAllConnections();
  proxy.close();
  for (const worker of workers) {
    if (worker.exitCode !== null) continue;
    if (worker.pid) process.kill(-worker.pid, "SIGTERM");
    await once(worker, "exit");
  }
}

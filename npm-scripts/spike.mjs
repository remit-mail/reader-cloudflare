import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 8791;
const base = `http://127.0.0.1:${port}`;

const wrangler = spawn(
  "node_modules/.bin/wrangler",
  ["dev", "--ip", "127.0.0.1", "--port", String(port), "--log-level", "warn"],
  {
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  },
);

const stopped = new Promise((resolve) => wrangler.once("exit", resolve));

const ready = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${base}/spike`).catch(() => null);
    if (response?.ok) return response.json();
    await delay(500);
  }
  throw new Error("wrangler dev did not come up within 60s");
};

const rows = [];
try {
  const names = await ready();
  for (const name of names) {
    const result = await (await fetch(`${base}/spike/${name}`)).json();
    rows.push({ probe: name, ok: result.ok, ms: result.durationMs, error: result.error ?? "" });
  }
} finally {
  process.kill(-wrangler.pid, "SIGTERM");
}

await stopped;
console.table(rows);
process.exit(rows.length > 0 && rows.every((row) => row.ok) ? 0 : 1);

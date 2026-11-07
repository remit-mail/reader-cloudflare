// A TCP proxy in front of the e2e Dovecot that a spec can break on demand. An
// account pointed at E2E_FAULT_IMAP_PORT talks to the real Dovecot through it.
// The control port, on loopback only, answers:
//   GET  /state           live connections, bytes relayed to the client, cuts
//                         and the byte count the last cut landed at
//   POST /cut             destroy every live connection now
//   POST /arm?bytes=N     destroy every live connection once N more bytes have
//                         reached the client, so a cut lands inside a transfer
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";

const listenPort = Number(process.env.E2E_FAULT_IMAP_PORT);
const controlPort = Number(process.env.E2E_FAULT_CONTROL_PORT);
const upstreamPort = Number(process.env.E2E_IMAP_PORT);

const live = new Set();
const state = { bytesToClient: 0, cuts: 0, lastCutAt: 0, armedAt: undefined };

const cutAll = () => {
  const count = live.size;
  for (const pair of live) {
    pair.client.destroy();
    pair.upstream.destroy();
  }
  live.clear();
  state.cuts += 1;
  state.lastCutAt = state.bytesToClient;
  state.armedAt = undefined;
  return count;
};

createServer((client) => {
  const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
  const pair = { client, upstream };
  live.add(pair);
  upstream.on("data", (chunk) => {
    client.write(chunk);
    state.bytesToClient += chunk.length;
    if (state.armedAt !== undefined && state.bytesToClient >= state.armedAt) cutAll();
  });
  client.on("data", (chunk) => upstream.write(chunk));
  const close = () => {
    live.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.on("close", close);
  upstream.on("close", close);
  client.on("error", close);
  upstream.on("error", close);
}).listen(listenPort, "127.0.0.1");

const report = () => ({
  connections: live.size,
  bytesToClient: state.bytesToClient,
  cuts: state.cuts,
  lastCutAt: state.lastCutAt,
  armed: state.armedAt !== undefined,
});

createHttpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method === "GET" && url.pathname === "/state") return reply(200, report());
  if (request.method === "POST" && url.pathname === "/cut") {
    return reply(200, { cut: cutAll(), ...report() });
  }
  if (request.method === "POST" && url.pathname === "/arm") {
    const bytes = Number(url.searchParams.get("bytes"));
    if (!Number.isInteger(bytes) || bytes <= 0) return reply(400, { error: "bytes must be > 0" });
    state.armedAt = state.bytesToClient + bytes;
    return reply(200, report());
  }
  return reply(404, { error: `no ${request.method} ${url.pathname}` });
}).listen(controlPort, "127.0.0.1");

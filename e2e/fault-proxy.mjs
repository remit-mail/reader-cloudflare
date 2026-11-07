// A TCP proxy in front of an e2e server that a spec can break on demand, run as
// `fault-proxy.mjs <listen port> <upstream port> <control port>`. An account
// pointed at the listen port talks to the real server through it. The control
// port, on loopback only, answers:
//   GET  /state           live connections, bytes relayed to the client, cuts,
//                         the byte count the last cut landed at, and how many
//                         SMTP messages the client finished sending
//   POST /cut             destroy every live connection now
//   POST /arm?bytes=N     destroy every live connection once N more bytes have
//                         reached the client, so a cut lands inside a transfer
//   POST /arm?after=data  let the client's next SMTP end of data (CRLF.CRLF)
//                         reach the server, then destroy every live connection
//                         when the server answers it, so the server has taken
//                         the message and the client never hears that it did
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";

const [listenPort, upstreamPort, controlPort] = process.argv.slice(2).map(Number);

const END_OF_DATA = Buffer.from("\r\n.\r\n");

const live = new Set();
const state = {
  bytesToClient: 0,
  cuts: 0,
  lastCutAt: 0,
  dataEnds: 0,
  armedAt: undefined,
  armedAfterData: false,
};

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
  state.armedAfterData = false;
  return count;
};

createServer((client) => {
  const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
  const pair = { client, upstream, tail: Buffer.alloc(0), swallowReply: false };
  live.add(pair);
  upstream.on("data", (chunk) => {
    if (pair.swallowReply) {
      cutAll();
      return;
    }
    client.write(chunk);
    state.bytesToClient += chunk.length;
    if (state.armedAt !== undefined && state.bytesToClient >= state.armedAt) cutAll();
  });
  client.on("data", (chunk) => {
    const seen = Buffer.concat([pair.tail, chunk]);
    pair.tail = seen.subarray(Math.max(0, seen.length - (END_OF_DATA.length - 1)));
    if (seen.includes(END_OF_DATA)) {
      state.dataEnds += 1;
      if (state.armedAfterData) pair.swallowReply = true;
    }
    upstream.write(chunk);
  });
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
  dataEnds: state.dataEnds,
  armed: state.armedAt !== undefined || state.armedAfterData,
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
    if (url.searchParams.get("after") === "data") {
      state.armedAfterData = true;
      return reply(200, report());
    }
    const bytes = Number(url.searchParams.get("bytes"));
    if (!Number.isInteger(bytes) || bytes <= 0) return reply(400, { error: "bytes must be > 0" });
    state.armedAt = state.bytesToClient + bytes;
    return reply(200, report());
  }
  return reply(404, { error: `no ${request.method} ${url.pathname}` });
}).listen(controlPort, "127.0.0.1");

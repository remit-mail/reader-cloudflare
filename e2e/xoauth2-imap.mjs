// Outlook signs IMAP in with XOAUTH2, which the test Dovecot does not speak.
// This shim sits in front of Dovecot, advertises XOAUTH2, accepts only a bearer
// token the fake Microsoft minted, and logs the user in with the shared test
// password. Everything after the login passes through untouched.
import { createConnection, createServer } from "node:net";

const listenPort = Number(process.env.E2E_XOAUTH2_PORT);
const upstreamPort = Number(process.env.E2E_IMAP_PORT);
const password = process.env.E2E_IMAP_PASSWORD ?? "";
const FAKE_TOKEN_PREFIX = "fake-access.";
const AUTHENTICATE = /^(\S+) AUTHENTICATE XOAUTH2 (\S+)$/i;

const field = (fields, prefix) =>
  fields.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);

const plainLogin = (tag, user, secret) =>
  `${tag} AUTHENTICATE PLAIN ${Buffer.from(`\0${user}\0${secret}`).toString("base64")}`;

const translate = (line) => {
  const match = AUTHENTICATE.exec(line);
  if (match === null) return undefined;
  const [, tag, payload] = match;
  const fields = Buffer.from(payload, "base64").toString("utf8").split("\x01");
  const user = field(fields, "user=");
  const bearer = field(fields, "auth=Bearer ");
  if (user === undefined || !bearer?.startsWith(FAKE_TOKEN_PREFIX)) {
    return plainLogin(tag, "xoauth2-refused", "not-a-fake-microsoft-token");
  }
  return plainLogin(tag, user, password);
};

createServer((client) => {
  const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
  let loggedIn = false;
  let pending = "";
  upstream.on("data", (chunk) => {
    if (loggedIn) {
      client.write(chunk);
      return;
    }
    client.write(
      chunk.toString("latin1").replaceAll("AUTH=PLAIN", "AUTH=XOAUTH2 AUTH=PLAIN"),
      "latin1",
    );
  });
  client.on("data", (chunk) => {
    if (loggedIn) {
      upstream.write(chunk);
      return;
    }
    pending += chunk.toString("latin1");
    let end = pending.indexOf("\r\n");
    while (!loggedIn && end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const login = translate(line);
      loggedIn = login !== undefined;
      upstream.write(`${login ?? line}\r\n`, "latin1");
      end = pending.indexOf("\r\n");
    }
    if (loggedIn && pending !== "") {
      upstream.write(pending, "latin1");
      pending = "";
    }
  });
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(listenPort, "127.0.0.1");

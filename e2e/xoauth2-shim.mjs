// Outlook signs IMAP and SMTP in with XOAUTH2, which neither the test Dovecot
// nor Mailpit speaks. This shim sits in front of each, advertises XOAUTH2,
// accepts only a bearer token the fake Microsoft minted, and signs the user in
// with PLAIN and the shared test password. Everything after the sign-in passes
// through untouched.
import { createConnection, createServer } from "node:net";

const password = process.env.E2E_IMAP_PASSWORD ?? "";
const FAKE_TOKEN_PREFIX = "fake-access.";
const REFUSED_USER = "xoauth2-refused";

const field = (fields, prefix) =>
  fields.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);

const plain = (user, secret) => Buffer.from(`\0${user}\0${secret}`).toString("base64");

const signIn = (payload) => {
  const fields = Buffer.from(payload, "base64").toString("utf8").split("\x01");
  const user = field(fields, "user=");
  const bearer = field(fields, "auth=Bearer ");
  if (user === undefined || !bearer?.startsWith(FAKE_TOKEN_PREFIX)) {
    return plain(REFUSED_USER, "not-a-fake-microsoft-token");
  }
  return plain(user, password);
};

const PROTOCOLS = {
  imap: {
    advertise: (text) => text.replaceAll("AUTH=PLAIN", "AUTH=XOAUTH2 AUTH=PLAIN"),
    translate: (line) => {
      const match = /^(\S+) AUTHENTICATE XOAUTH2 (\S+)$/i.exec(line);
      return match === null ? undefined : `${match[1]} AUTHENTICATE PLAIN ${signIn(match[2])}`;
    },
  },
  smtp: {
    advertise: (text) => text.replace(/^(250[- ]AUTH )/gm, "$1XOAUTH2 "),
    translate: (line) => {
      const match = /^AUTH XOAUTH2 (\S+)$/i.exec(line);
      return match === null ? undefined : `AUTH PLAIN ${signIn(match[1])}`;
    },
  },
};

const shim = ({ advertise, translate }, listenPort, upstreamPort) =>
  createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: upstreamPort });
    let signedIn = false;
    let pending = "";
    upstream.on("data", (chunk) => {
      if (signedIn) {
        client.write(chunk);
        return;
      }
      client.write(advertise(chunk.toString("latin1")), "latin1");
    });
    client.on("data", (chunk) => {
      if (signedIn) {
        upstream.write(chunk);
        return;
      }
      pending += chunk.toString("latin1");
      let end = pending.indexOf("\r\n");
      while (!signedIn && end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const translated = translate(line);
        signedIn = translated !== undefined;
        upstream.write(`${translated ?? line}\r\n`, "latin1");
        end = pending.indexOf("\r\n");
      }
      if (signedIn && pending !== "") {
        upstream.write(pending, "latin1");
        pending = "";
      }
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(listenPort, "127.0.0.1");

shim(PROTOCOLS.imap, Number(process.env.E2E_XOAUTH2_IMAP_PORT), Number(process.env.E2E_IMAP_PORT));
shim(PROTOCOLS.smtp, Number(process.env.E2E_XOAUTH2_SMTP_PORT), Number(process.env.E2E_SMTP_PORT));

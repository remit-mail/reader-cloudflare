import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ImapFlow } from "imapflow";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { imap, imapLaneFor } from "../.reader/packages/e2e/src/env.js";
import { deadLettersOf, mailStoreOf, r2Store, rowsIn } from "./local-store.js";
import {
  connectImapAccount,
  eraseTenant,
  type ImapAccount,
  mintIdentity,
  tenantJson,
  tenantRequest,
} from "./tenant.js";

const IDENTITY = mintIdentity("chaos-parse");
const json = tenantJson(IDENTITY);
const request = tenantRequest(IDENTITY);

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "chaos");
const MALFORMED = [
  "unterminated-boundary.eml",
  "invalid-base64.eml",
  "nul-bytes.eml",
  "header-without-colon.eml",
];
const BODY_PROCESS_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
const LARGE_ATTACHMENT_BYTES = 26 * 1024 * 1024;

type Terminal = "Stored" | "Quarantined" | "Broken" | "Reconciled";

interface Seeded {
  readonly name: string;
  readonly malformed: boolean;
  readonly raw: Buffer;
  uid: number;
}

const wellFormed = (index: number): Buffer =>
  Buffer.from(
    [
      "From: Neighbour <neighbour@remit.test>",
      "To: reader@remit.test",
      `Subject: Chaos neighbour ${index}`,
      `Date: Mon, 02 Nov 2026 10:0${index}:00 +0000`,
      `Message-ID: <neighbour-${index}@chaos.remit.test>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      `A well-formed message that shares a body batch, number ${index}.`,
      "",
    ].join("\r\n"),
  );

const base64Lines = (bytes: Buffer): string =>
  bytes.toString("base64").replace(/.{76}/g, (line) => `${line}\r\n`);

const largeMessage = (): Buffer => {
  const attachment = Buffer.alloc(LARGE_ATTACHMENT_BYTES);
  for (let at = 0; at < attachment.length; at++) attachment[at] = (at * 31 + (at >> 12)) & 0xff;
  return Buffer.from(
    [
      "From: Chaos <chaos@remit.test>",
      "To: reader@remit.test",
      "Subject: Chaos: over the body budget",
      "Date: Mon, 02 Nov 2026 09:04:00 +0000",
      "Message-ID: <over-budget@chaos.remit.test>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="chaos-large"',
      "",
      "--chaos-large",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "A message larger than the bytes one body job may hold in flight.",
      "--chaos-large",
      'Content-Type: application/octet-stream; name="ballast.bin"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="ballast.bin"',
      "",
      base64Lines(attachment),
      "--chaos-large--",
      "",
    ].join("\r\n"),
  );
};

const appendAll = async (user: string, seeded: Seeded[]): Promise<void> => {
  const { host, port } = imapLaneFor(user).suite;
  const client = new ImapFlow({
    host,
    port,
    secure: false,
    auth: { user, pass: imap.password },
    logger: false,
  });
  await client.connect();
  try {
    for (const message of seeded) {
      const appended = await client.append("INBOX", message.raw);
      if (appended === false || appended.uid === undefined) {
        throw new Error(`Dovecot did not report a uid for ${message.name}`);
      }
      message.uid = appended.uid;
    }
  } finally {
    await client.logout();
  }
};

interface Row {
  readonly messageId: string;
  readonly uid: number;
  readonly stored: boolean;
}

const inboxRows = (store: string, mailboxId: string): Row[] =>
  rowsIn(
    store,
    "select message_id, uid, body_storage_key from message where mailbox_id = ?",
    mailboxId,
  ).map((row) => ({
    messageId: String(row.message_id),
    uid: Number(row.uid),
    stored: row.body_storage_key !== null,
  }));

const quarantinedUids = (store: string, mailboxId: string): Set<number> =>
  new Set(
    rowsIn(store, "select uid from quarantine where mailbox_id = ?", mailboxId).map((row) =>
      Number(row.uid),
    ),
  );

const markedBroken = (messageId: string): boolean =>
  rowsIn(
    r2Store(),
    "select key from _mf_objects where instr(key, ?) > 0 and instr(key, '.sync-failed') > 0",
    messageId,
  ).length > 0;

const terminalStates = (
  store: string,
  mailboxId: string,
  seeded: Seeded[],
): Map<string, Terminal | "Pending"> => {
  const rows = inboxRows(store, mailboxId);
  const quarantined = quarantinedUids(store, mailboxId);
  return new Map(
    seeded.map((message) => {
      const row = rows.find((candidate) => candidate.uid === message.uid);
      if (row === undefined) return [message.name, "Reconciled"];
      if (row.stored) return [message.name, "Stored"];
      if (quarantined.has(message.uid)) return [message.name, "Quarantined"];
      if (markedBroken(row.messageId)) return [message.name, "Broken"];
      return [message.name, "Pending"];
    }),
  );
};

const shared: { account: ImapAccount; mailboxId: string } = {
  account: { accountId: "", imapUser: "" },
  mailboxId: "",
};

test.describe("chaos: parsing", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => eraseTenant(json, IDENTITY));

  test("a malformed or oversized message never sinks its body batch", async () => {
    test.setTimeout(600_000);
    shared.account = await connectImapAccount(json);
    const mailboxes = await json<{ items?: { mailboxId: string; fullPath: string }[] }>(
      "GET",
      `/accounts/${shared.account.accountId}/mailboxes`,
    );
    shared.mailboxId =
      mailboxes.items?.find((mailbox) => mailbox.fullPath === "INBOX")?.mailboxId ?? "";

    const large = largeMessage();
    expect(large.length).toBeGreaterThan(BODY_PROCESS_BYTES_IN_FLIGHT);
    const seeded: Seeded[] = [
      { name: "neighbour-1", malformed: false, raw: wellFormed(1), uid: 0 },
      ...MALFORMED.flatMap((name, index) => [
        { name, malformed: true, raw: readFileSync(join(FIXTURES, name)), uid: 0 },
        {
          name: `neighbour-${index + 2}`,
          malformed: false,
          raw: wellFormed(index + 2),
          uid: 0,
        },
      ]),
      { name: "over-budget", malformed: true, raw: large, uid: 0 },
      { name: "neighbour-9", malformed: false, raw: wellFormed(9), uid: 0 },
    ];
    await appendAll(shared.account.imapUser, seeded);
    await json("POST", `/accounts/${shared.account.accountId}/sync`);

    const store = mailStoreOf(shared.account.accountId);
    await waitFor(
      async () => inboxRows(store, shared.mailboxId),
      (rows) => seeded.every((message) => rows.some((row) => row.uid === message.uid)),
      { timeoutMs: 120_000, what: "every seeded message in the read model" },
    );
    const settled = await waitFor(
      async () => terminalStates(store, shared.mailboxId, seeded),
      (states) => [...states.values()].every((state) => state !== "Pending"),
      { timeoutMs: 480_000, what: "every seeded message to reach a body or a recorded failure" },
    );
    console.log(`chaos-parse outcomes: ${JSON.stringify(Object.fromEntries(settled))}`);

    for (const message of seeded.filter((candidate) => !candidate.malformed)) {
      expect(settled.get(message.name), message.name).toBe("Stored");
    }
    for (const message of seeded.filter((candidate) => candidate.malformed)) {
      expect(["Stored", "Quarantined", "Broken"], message.name).toContain(
        settled.get(message.name),
      );
    }
    expect(deadLettersOf(IDENTITY)).toEqual([]);
  });

  test("each malformed message opens with a body or a clear failure", async () => {
    const store = mailStoreOf(shared.account.accountId);
    const rows = inboxRows(store, shared.mailboxId);
    const quarantined = quarantinedUids(store, shared.mailboxId);
    const outcomes: Record<string, string> = {};
    for (const row of rows) {
      const response = await request("GET", `/messages/${row.messageId}`);
      const body: unknown = await response.json();
      outcomes[row.uid] = `${response.status}`;
      if (row.stored) {
        expect(response.status, `uid ${row.uid}`).toBe(200);
        expect(body).toHaveProperty("bodyParts");
        continue;
      }
      expect(response.status, `uid ${row.uid}`).not.toBe(200);
      expect(response.status, `uid ${row.uid}`).not.toBe(202);
      expect(JSON.stringify(body), `uid ${row.uid}`).toMatch(/message/i);
      if (quarantined.has(row.uid)) continue;
      expect(markedBroken(row.messageId), `uid ${row.uid}`).toBe(true);
    }
    console.log(`chaos-parse opens: ${JSON.stringify(outcomes)}`);
  });
});

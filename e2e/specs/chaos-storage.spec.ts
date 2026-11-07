import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildBodyPartKey,
  buildMessageBodyKey,
  buildParsedBodyKey,
  MATERIALIZED_SENTINEL_PART_PATH,
} from "@remit/storage-service";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendMessages } from "../.reader/packages/e2e/src/imap.js";
import { queueConsumesOf } from "./local-store.js";
import {
  connectImapAccount,
  eraseTenant,
  type Json,
  mintIdentity,
  plainTextUrlOf,
  tenantJson,
} from "./tenant.js";

const BUCKET = "reader-cloudflare-mail";
const BODY = "The tide table went missing from the bucket.";
const PART_KEY = /\/content\/(accounts\/([^/]+)\/([^/]+)\/messages\/([^/]+)\/parts\/([^/?]+))/;

const persistDir = (): string => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return dirname(path);
};

const deleteObject = (key: string): void => {
  const result = spawnSync(
    join(process.cwd(), "node_modules", ".bin", "wrangler"),
    [
      "r2",
      "object",
      "delete",
      `${BUCKET}/${key}`,
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      persistDir(),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler r2 object delete ${key} failed: ${result.stderr}`);
  }
};

interface StoredPart {
  readonly url: string;
  readonly key: string;
  readonly messageKeys: readonly string[];
}

const storedPartOf = (url: string): StoredPart => {
  const match = PART_KEY.exec(url);
  if (match === null) throw new Error(`${url} names no body part`);
  const [, key = "", accountConfigId = "", accountId = "", messageId = ""] = match;
  return {
    url,
    key,
    messageKeys: [
      buildMessageBodyKey(accountConfigId, accountId, messageId),
      buildParsedBodyKey(accountConfigId, accountId, messageId),
      buildBodyPartKey(accountConfigId, accountId, messageId, MATERIALIZED_SENTINEL_PART_PATH),
    ],
  };
};

interface Read {
  readonly status: number;
  readonly text: string;
}

interface Opened {
  readonly identity: string;
  readonly json: Json;
  readonly messageId: string;
  readonly part: StoredPart;
}

const readContent = async ({ identity, part }: Opened): Promise<Read> => {
  const response = await fetch(part.url, { headers: { "x-dev-identity": identity } });
  return { status: response.status, text: await response.text() };
};

// The web client describes the message again before each retry of a 202, and
// that describe is what re-arms the body sync and materializes the parts.
const readLikeTheClient = (opened: Opened): Promise<Read> =>
  waitFor(
    async () => {
      await opened.json("GET", `/messages/${opened.messageId}`);
      return readContent(opened);
    },
    (read) => read.status !== 202,
    { timeoutMs: 90_000, intervalMs: 2_000, what: `the body of ${opened.messageId} again` },
  );

const openSyncedMessage = async (identity: string, json: Json): Promise<Opened> => {
  const account = await connectImapAccount(json);
  const subject = `Missing body ${Date.now()}`;
  await appendMessages(account.imapUser, [{ subject, body: BODY }]);
  await json("POST", `/accounts/${account.accountId}/sync`);
  const { items } = await json<{ items: { mailboxId: string; fullPath: string }[] }>(
    "GET",
    `/accounts/${account.accountId}/mailboxes`,
  );
  const inbox = items.find((mailbox) => mailbox.fullPath === "INBOX");
  if (inbox === undefined) throw new Error("the account has no INBOX");
  const threads = await waitFor(
    () =>
      json<{ items?: { subject: string; messageId: string }[] }>(
        "GET",
        `/mailboxes/${inbox.mailboxId}/threads`,
      ).then((page) => page.items ?? []),
    (listed) => listed.some((thread) => thread.subject === subject),
    { timeoutMs: 90_000, what: `"${subject}" in the read model` },
  );
  const messageId = threads.find((thread) => thread.subject === subject)?.messageId;
  if (messageId === undefined) throw new Error("matched but not found");
  const part = storedPartOf(plainTextUrlOf(await json("GET", `/messages/${messageId}`)));
  const opened = { identity, json, messageId, part };
  const synced = await readLikeTheClient(opened);
  expect(synced).toEqual({ status: 200, text: expect.stringContaining(BODY) });
  return opened;
};

test.describe("chaos: storage", () => {
  let identity: string;
  let json: Json;

  test.beforeEach(() => {
    identity = mintIdentity("chaos-storage");
    json = tenantJson(identity);
  });

  test.afterEach(async () => {
    await eraseTenant(json, identity);
  });

  test("a body whose R2 objects all went missing is fetched again from IMAP", async () => {
    const opened = await openSyncedMessage(identity, json);
    for (const key of [opened.part.key, ...opened.part.messageKeys]) deleteObject(key);

    expect((await readContent(opened)).status).toBe(202);
    expect(await readLikeTheClient(opened)).toEqual({
      status: 200,
      text: expect.stringContaining(BODY),
    });
  });

  test("a part that went missing under its materialized marker is restored", async () => {
    const opened = await openSyncedMessage(identity, json);
    const deletedAt = Date.now();
    deleteObject(opened.part.key);

    expect((await readContent(opened)).status).toBe(202);
    expect(await readLikeTheClient(opened)).toEqual({
      status: 200,
      text: expect.stringContaining(BODY),
    });
    expect(
      queueConsumesOf(identity, deletedAt).filter(
        (consume) => consume.type === "SYNC_MESSAGE_BODY",
      ),
    ).toEqual([]);
  });
});

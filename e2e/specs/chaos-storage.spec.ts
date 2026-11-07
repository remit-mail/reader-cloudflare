import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { appendMessages } from "../.reader/packages/e2e/src/imap.js";
import {
  connectImapAccount,
  eraseTenant,
  type Json,
  mintIdentity,
  type TenantRequest,
  tenantJson,
  tenantRequest,
} from "./tenant";

const BUCKET = "reader-cloudflare-mail";
const BODY = "The tide table went missing from the bucket.";

const persistDir = (): string => {
  const path = process.env.E2E_WRANGLER_LOG;
  if (path === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  return dirname(path);
};

const keySchema = z.object({ key: z.string() });

const storedKeysOf = (messageId: string): string[] => {
  const dir = join(persistDir(), "v3", "r2", "miniflare-R2BucketObject");
  const [file] = readdirSync(dir).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (file === undefined) throw new Error(`no local R2 store under ${dir}`);
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try {
    return db
      .prepare("select key from _mf_objects where instr(key, ?) > 0")
      .all(`/messages/${messageId}/`)
      .map((row) => keySchema.parse(row).key);
  } finally {
    db.close();
  }
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

const threadSchema = z.object({ subject: z.string(), messageId: z.string() });
const mailboxSchema = z.object({ mailboxId: z.string(), fullPath: z.string() });
const partSchema = z.object({
  mediaType: z.string(),
  mediaSubtype: z.string(),
  contentUrl: z.string(),
});
const describedSchema = z.object({ bodyParts: z.array(partSchema) });

const inboxOf = async (json: Json, accountId: string): Promise<string> => {
  const { items } = z
    .object({ items: z.array(mailboxSchema) })
    .parse(await json("GET", `/accounts/${accountId}/mailboxes`));
  const inbox = items.find((mailbox) => mailbox.fullPath === "INBOX");
  if (inbox === undefined) throw new Error("the account has no INBOX");
  return inbox.mailboxId;
};

const messageIdOf = async (json: Json, mailboxId: string, subject: string): Promise<string> => {
  const threads = await waitFor(
    async () =>
      z
        .object({ items: z.array(threadSchema).optional() })
        .parse(await json("GET", `/mailboxes/${mailboxId}/threads`)).items ?? [],
    (items) => items.some((thread) => thread.subject === subject),
    { timeoutMs: 90_000, what: `"${subject}" in the read model` },
  );
  const thread = threads.find((candidate) => candidate.subject === subject);
  if (thread === undefined) throw new Error("matched but not found");
  return thread.messageId;
};

const plainTextUrlOf = async (json: Json, messageId: string): Promise<string> => {
  const { bodyParts } = describedSchema.parse(await json("GET", `/messages/${messageId}`));
  const part = bodyParts.find(
    (candidate) =>
      `${candidate.mediaType}/${candidate.mediaSubtype}`.toLowerCase() === "text/plain",
  );
  if (part === undefined) throw new Error(`message ${messageId} has no text/plain part`);
  return part.contentUrl;
};

interface Read {
  readonly status: number;
  readonly text: string;
}

const readContent = async (identity: string, url: string): Promise<Read> => {
  const response = await fetch(url, { headers: { "x-dev-identity": identity } });
  return { status: response.status, text: await response.text() };
};

test.describe("chaos: storage", () => {
  let identity: string;
  let json: Json;
  let request: TenantRequest;

  test.beforeEach(() => {
    identity = mintIdentity("chaos-storage");
    json = tenantJson(identity);
    request = tenantRequest(identity);
  });

  test.afterEach(async () => {
    await eraseTenant(json, identity);
  });

  test("a body whose R2 objects went missing is fetched again from IMAP", async () => {
    const account = await connectImapAccount(json);
    const subject = `Missing body ${Date.now()}`;
    await appendMessages(account.imapUser, [{ subject, body: BODY }]);
    expect((await request("POST", `/accounts/${account.accountId}/sync`)).status).toBeLessThan(300);
    const messageId = await messageIdOf(json, await inboxOf(json, account.accountId), subject);

    const url = await plainTextUrlOf(json, messageId);
    const synced = await waitFor(
      () => readContent(identity, url),
      (read) => read.status === 200,
      { timeoutMs: 90_000, what: `the body of "${subject}"` },
    );
    expect(synced.text).toContain(BODY);

    const keys = storedKeysOf(messageId);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) deleteObject(key);
    expect(storedKeysOf(messageId)).toEqual([]);

    const missed = await readContent(identity, url);
    expect(missed.status).toBe(202);

    const refetched = await waitFor(
      () => readContent(identity, url),
      (read) => read.status !== 202,
      { timeoutMs: 90_000, intervalMs: 2_000, what: `the refetched body of "${subject}"` },
    );
    expect(refetched).toEqual({ status: 200, text: expect.stringContaining(BODY) });
    expect(storedKeysOf(messageId).length).toBeGreaterThan(0);
  });
});

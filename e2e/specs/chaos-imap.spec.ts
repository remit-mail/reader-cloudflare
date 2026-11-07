import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { imap } from "../.reader/packages/e2e/src/env.js";
import {
  appendMessages,
  createServerMailbox,
  deleteServerMailbox,
  listServerSubjects,
  type Message,
} from "../.reader/packages/e2e/src/imap.js";
import {
  connectImapAccount,
  type ImapAccount,
  type Json,
  mintIdentity,
  tenantJson,
} from "./tenant";

const SEEDED_COUNT = 500;
const CUT_AFTER_BYTES = 40_000;
const FOLDER = "Chaos";

const requiredPort = (name: string): number => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; run \`npm run e2e\``);
  return Number(value);
};

const proxied = { host: "127.0.0.1", port: requiredPort("E2E_FAULT_IMAP_PORT") };
const control = `http://127.0.0.1:${requiredPort("E2E_FAULT_CONTROL_PORT")}`;

const proxyStateSchema = z.object({
  connections: z.number(),
  bytesToClient: z.number(),
  cuts: z.number(),
  lastCutAt: z.number(),
  armed: z.boolean(),
});
type ProxyState = z.infer<typeof proxyStateSchema>;

const proxy = async (method: string, path: string): Promise<ProxyState> => {
  const response = await fetch(`${control}${path}`, { method });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
  return proxyStateSchema.parse(await response.json());
};

interface ListedMailbox {
  readonly mailboxId: string;
  readonly fullPath: string;
}

interface ListedThread {
  readonly threadId: string;
  readonly messageId: string;
  readonly subject?: string;
}

interface ThreadPage {
  readonly items?: ListedThread[];
  readonly continuationToken?: string;
}

interface SyncStatus {
  readonly syncPhase?: string;
  readonly mailboxes: ReadonlyArray<{
    readonly fullPath: string;
    readonly messagesTotal: number;
    readonly messagesSynced: number;
  }>;
}

const mailboxIdOf = async (json: Json, account: ImapAccount, path: string): Promise<string> => {
  const { items } = await json<{ items?: ListedMailbox[] }>(
    "GET",
    `/accounts/${account.accountId}/mailboxes`,
  );
  const mailbox = (items ?? []).find((candidate) => candidate.fullPath === path);
  if (mailbox === undefined) throw new Error(`${path} is not listed yet`);
  return mailbox.mailboxId;
};

const allThreads = async (json: Json, mailboxId: string): Promise<ListedThread[]> => {
  const threads: ListedThread[] = [];
  let token: string | undefined;
  do {
    const query =
      token === undefined ? "" : `?${new URLSearchParams({ continuationToken: token })}`;
    const page = await json<ThreadPage>("GET", `/mailboxes/${mailboxId}/threads${query}`);
    threads.push(...(page.items ?? []));
    token = page.continuationToken;
  } while (token !== undefined);
  return threads;
};

const threadsIn = async (json: Json, account: ImapAccount, path: string): Promise<ListedThread[]> =>
  allThreads(json, await mailboxIdOf(json, account, path));

const subjectsOf = (threads: ListedThread[]): string[] =>
  threads.map((thread) => thread.subject ?? "").sort();

const syncUntil = async (
  json: Json,
  account: ImapAccount,
  path: string,
  accept: (threads: ListedThread[]) => boolean,
  what: string,
): Promise<ListedThread[]> => {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await json("POST", `/accounts/${account.accountId}/sync`).catch(() => undefined);
    const settled = await waitFor(() => threadsIn(json, account, path), accept, {
      timeoutMs: 20_000,
      intervalMs: 2_000,
      what,
    }).then(
      (threads) => threads,
      () => undefined,
    );
    if (settled !== undefined) return settled;
  }
  throw new Error(`timed out waiting for ${what}`);
};

const countSchema = z.object({ rows: z.number() });

const deadLetterRows = (): number => {
  const log = process.env.E2E_WRANGLER_LOG;
  if (log === undefined) throw new Error("E2E_WRANGLER_LOG is not set; run `npm run e2e`");
  const dir = join(dirname(log), "v3", "d1", "miniflare-D1DatabaseObject");
  const [file] = readdirSync(dir).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (file === undefined) throw new Error(`no local D1 store under ${dir}`);
  const db = new DatabaseSync(join(dir, file), { readOnly: true });
  try {
    return countSchema.parse(db.prepare("select count(*) as rows from dead_letter").get()).rows;
  } finally {
    db.close();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const plainTextUrlOf = (description: unknown): string | undefined => {
  if (!isRecord(description) || !Array.isArray(description.bodyParts)) return undefined;
  const part: unknown = description.bodyParts.find(
    (entry: unknown) =>
      isRecord(entry) &&
      typeof entry.mediaType === "string" &&
      typeof entry.mediaSubtype === "string" &&
      `${entry.mediaType}/${entry.mediaSubtype}`.toLowerCase() === "text/plain",
  );
  return isRecord(part) && typeof part.contentUrl === "string" ? part.contentUrl : undefined;
};

interface ServedBody {
  readonly status: number;
  readonly contentUrl?: string;
  readonly text?: string;
}

interface Tenant {
  readonly identity: string;
  readonly json: Json;
}

const newTenant = (): Tenant => {
  const identity = mintIdentity("chaos");
  return { identity, json: tenantJson(identity) };
};

const servedBodyOf = async (tenant: Tenant, messageId: string): Promise<ServedBody> => {
  const described = await tenant.json<unknown>("GET", `/messages/${messageId}`).then(
    (body) => ({ ok: true as const, body }),
    () => ({ ok: false as const }),
  );
  if (!described.ok) return { status: 404 };
  const contentUrl = plainTextUrlOf(described.body);
  if (contentUrl === undefined) return { status: 200 };
  const content = await fetch(contentUrl, { headers: { "x-dev-identity": tenant.identity } });
  if (!content.ok) return { status: content.status, contentUrl };
  return { status: 200, contentUrl, text: await content.text() };
};

const uidValidityOf = async (user: string, path: string): Promise<bigint> => {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: false,
    auth: { user, pass: imap.password },
    logger: false,
  });
  await client.connect();
  try {
    const status = await client.status(path, { uidValidity: true });
    if (status.uidValidity === undefined) throw new Error(`${path} carries no UIDVALIDITY`);
    return status.uidValidity;
  } finally {
    await client.logout();
  }
};

const letters = (tag: string, count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    subject: `${tag} ${String(index).padStart(4, "0")}`,
    body: `${tag} body ${index}. ${"The tide turns at the harbour wall. ".repeat(20)}`,
  }));

test.describe("IMAP faults", () => {
  test.setTimeout(420_000);

  test("a connection cut mid-sync leaves exactly the server's messages", async () => {
    const tenant = newTenant();
    const { json } = tenant;
    const account = await connectImapAccount(json, proxied);
    const deadLettersBefore = deadLetterRows();
    await appendMessages(account.imapUser, letters("Drop", SEEDED_COUNT));
    const onServer = (await listServerSubjects(account.imapUser)).sort();
    expect(onServer).toHaveLength(SEEDED_COUNT);

    const armed = await proxy("POST", `/arm?bytes=${CUT_AFTER_BYTES}`);
    await json("POST", `/accounts/${account.accountId}/sync`);
    const cut = await waitFor(
      () => proxy("GET", "/state"),
      (state) => state.cuts > armed.cuts,
      { timeoutMs: 60_000, what: "the proxy to cut the sync's connection" },
    );
    const atCut = await json<SyncStatus>("GET", `/accounts/${account.accountId}/sync/status`);
    const inboxAtCut = atCut.mailboxes.find((mailbox) => mailbox.fullPath === "INBOX");
    const listedAtCut = (await threadsIn(json, account, "INBOX")).length;
    console.log(
      `drop: cut after ${cut.lastCutAt - armed.bytesToClient} bytes; ` +
        `phase ${atCut.syncPhase}, inbox ${inboxAtCut?.messagesSynced}/${inboxAtCut?.messagesTotal}, ` +
        `${listedAtCut} threads listed`,
    );
    expect(listedAtCut).toBeLessThan(SEEDED_COUNT);

    const synced = await syncUntil(
      json,
      account,
      "INBOX",
      (threads) => threads.length >= SEEDED_COUNT,
      `all ${SEEDED_COUNT} messages after the cut`,
    );
    await new Promise((settle) => setTimeout(settle, 5_000));
    const settled = await threadsIn(json, account, "INBOX");

    expect(subjectsOf(settled)).toEqual(onServer);
    expect(new Set(settled.map((thread) => thread.threadId)).size).toBe(settled.length);
    expect(new Set(settled.map((thread) => thread.messageId)).size).toBe(settled.length);
    expect(synced.length).toBe(SEEDED_COUNT);
    console.log(
      `drop: ${(await proxy("GET", "/state")).bytesToClient - armed.bytesToClient} bytes relayed in all`,
    );
    expect(deadLetterRows()).toBe(deadLettersBefore);
  });

  test("a folder recreated under a new UIDVALIDITY lists and serves only its new mail", async () => {
    const tenant = newTenant();
    const { json } = tenant;
    const account = await connectImapAccount(json, proxied);
    const before = letters("Before", 3);
    const after = letters("After", 2);

    await createServerMailbox(account.imapUser, FOLDER);
    await appendMessages(account.imapUser, before, FOLDER);
    const oldValidity = await uidValidityOf(account.imapUser, FOLDER);
    const oldThreads = await syncUntil(
      json,
      account,
      FOLDER,
      (threads) => threads.length === before.length,
      `the first ${before.length} messages in ${FOLDER}`,
    );
    const oldBodies = await Promise.all(
      oldThreads.map((thread) =>
        waitFor(
          () => servedBodyOf(tenant, thread.messageId),
          (served) => served.text !== undefined,
          { timeoutMs: 90_000, what: `the body of "${thread.subject}"` },
        ),
      ),
    );

    await deleteServerMailbox(account.imapUser, FOLDER);
    await new Promise((settle) => setTimeout(settle, 1_100));
    await createServerMailbox(account.imapUser, FOLDER);
    await appendMessages(account.imapUser, after, FOLDER);
    expect(await uidValidityOf(account.imapUser, FOLDER)).not.toBe(oldValidity);
    const onServer = (await listServerSubjects(account.imapUser, FOLDER)).sort();

    const newThreads = await syncUntil(
      json,
      account,
      FOLDER,
      (threads) => subjectsOf(threads).join("\n") === onServer.join("\n"),
      `only the recreated ${FOLDER}'s mail`,
    );
    expect(subjectsOf(newThreads)).toEqual(onServer);

    for (const thread of newThreads) {
      const served = await waitFor(
        () => servedBodyOf(tenant, thread.messageId),
        (body) => body.text !== undefined,
        { timeoutMs: 90_000, what: `the body of "${thread.subject}"` },
      );
      expect(served.text).toContain(`${thread.subject?.split(" ")[0]} body`);
      expect(served.text).not.toContain("Before body");
    }
    for (const [index, thread] of oldThreads.entries()) {
      const served = await servedBodyOf(tenant, thread.messageId);
      expect(served.text, `the old body of "${thread.subject}"`).toBeUndefined();
      const contentUrl = oldBodies[index]?.contentUrl;
      if (contentUrl === undefined) throw new Error(`no content URL for "${thread.subject}"`);
      await waitFor(
        () =>
          fetch(contentUrl, { headers: { "x-dev-identity": tenant.identity } }).then(
            (response) => response.status,
          ),
        (status) => status !== 200,
        { timeoutMs: 60_000, what: `the old body of "${thread.subject}" to stop being served` },
      );
    }
  });
});

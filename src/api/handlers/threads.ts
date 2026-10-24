import type { ThreadSearchResponse } from "@remit/api-openapi-types";
import { z } from "zod";
import type { MailboxRow, ThreadCursor, ThreadQuery } from "../../mail/types";
import { tenantMail, tenantSearch } from "../../stubs";
import { decodeCursor, encodeCursor } from "../cursor";
import {
  accountIdsByMailbox,
  inboxesOf,
  toMailboxResponse,
  toThreadMessageResponse,
} from "../mappers";
import {
  type ApiRequest,
  accountOf,
  accountsOf,
  booleanParam,
  type Handler,
  limitParam,
  listParam,
  orderParam,
  parse,
} from "../request";
import { invalid, notFound, ok, optional } from "../respond";

const DEFAULT_LIMIT = 50;
const SEARCH_LIMIT = 500;

const mailboxParams = z.object({ mailboxId: z.string().min(1) });
const accountParams = z.object({ accountId: z.string().min(1) });
const threadParams = z.object({ threadId: z.string().min(1) });

const listQuery = z.object({
  continuationToken: z.string().optional(),
  order: orderParam,
});

const searchQuery = listQuery.extend({
  query: z.string().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  unread: booleanParam,
  starred: booleanParam,
  attachments: booleanParam,
  senderTrust: listParam,
  category: listParam,
  dkimMismatch: booleanParam,
  count: booleanParam,
  results: booleanParam,
  limit: limitParam,
});

const allThreadsQuery = searchQuery.extend({
  accountId: z.string().optional(),
  mailboxId: z.string().optional(),
  muted: booleanParam,
});

type SearchQuery = z.infer<typeof allThreadsQuery>;

const text = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

const excludesAll = (query: SearchQuery): boolean =>
  (query.category !== undefined && !query.category.includes("uncategorized")) ||
  (query.senderTrust !== undefined && !query.senderTrust.includes("unknown")) ||
  query.dkimMismatch === true ||
  query.muted === true;

const searchHits = async (
  request: ApiRequest,
  search: string | null,
  mailboxes: readonly MailboxRow[],
): Promise<readonly string[] | null> => {
  if (search === null) return null;
  const hits = await tenantSearch(request.env, request.tenant.tenantId).search({
    query: search,
    limit: SEARCH_LIMIT,
    accountIds: [...new Set(mailboxes.map((mailbox) => mailbox.accountId))],
    mailboxIds: mailboxes.map((mailbox) => mailbox.mailboxId),
  });
  return hits.map((hit) => hit.messageId);
};

const respondThreads = async (
  request: ApiRequest,
  mailboxes: readonly MailboxRow[],
  query: SearchQuery,
  cursor: ThreadCursor | null,
): Promise<Response> => {
  if (excludesAll(query)) {
    const empty: ThreadSearchResponse = { items: [], ...optional("count", query.count ? 0 : null) };
    return ok(empty);
  }
  const messageIds = await searchHits(request, text(query.query), mailboxes);
  const threadQuery: ThreadQuery = {
    mailboxIds: mailboxes.map((mailbox) => mailbox.mailboxId),
    messageIds,
    unread: query.unread ?? null,
    starred: query.starred ?? null,
    attachments: query.attachments ?? null,
    from: text(query.from),
    subject: text(query.subject),
    order: query.order ?? "desc",
    cursor,
    limit: query.limit ?? DEFAULT_LIMIT,
  };
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const page = query.results === false ? null : await mail.listThreads(threadQuery);
  const total = query.count === true ? await mail.countThreads(threadQuery) : null;
  const accountIds = accountIdsByMailbox(mailboxes);
  const body: ThreadSearchResponse = {
    ...optional(
      "items",
      page?.rows.map((row) => toThreadMessageResponse(row, accountIds)),
    ),
    ...optional("continuationToken", page?.next ? encodeCursor(page.next) : null),
    ...optional("count", total),
  };
  return ok(body);
};

const mailboxThreads =
  (schema: typeof searchQuery | typeof listQuery): Handler =>
  async (context, request) => {
    const params = parse(mailboxParams, context.request.params, "path");
    if (!params.ok) return params.response;
    const query = parse(schema, context.request.query, "query");
    if (!query.ok) return query.response;
    const cursor = decodeCursor(query.value.continuationToken);
    if (!cursor.ok) return invalid("continuationToken cannot be decoded");
    const mailbox = await tenantMail(request.env, request.tenant.tenantId).findMailbox(
      params.value.mailboxId,
    );
    if (mailbox === null) return notFound("Mailbox");
    const account = await accountOf(request, mailbox.accountId);
    if (account === undefined) return notFound("Mailbox");
    return respondThreads(request, [mailbox], query.value, cursor.cursor);
  };

const scopeMailboxes = (mailboxes: readonly MailboxRow[], query: SearchQuery): MailboxRow[] => {
  if (query.mailboxId !== undefined) {
    return mailboxes.filter((mailbox) => mailbox.mailboxId === query.mailboxId);
  }
  if (query.starred === true || text(query.query) !== null) return [...mailboxes];
  return inboxesOf(mailboxes);
};

const listAllThreads: Handler = async (context, request) => {
  const query = parse(allThreadsQuery, context.request.query, "query");
  if (!query.ok) return query.response;
  const cursor = decodeCursor(query.value.continuationToken);
  if (!cursor.ok) return invalid("continuationToken cannot be decoded");
  const accounts = (await accountsOf(request)).filter(
    (account) => query.value.accountId === undefined || account.accountId === query.value.accountId,
  );
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxRows(
    accounts.map((account) => account.accountId),
  );
  return respondThreads(
    request,
    scopeMailboxes(mailboxes, query.value),
    query.value,
    cursor.cursor,
  );
};

const listThreadMessages: Handler = async (context, request) => {
  const params = parse(threadParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const query = parse(listQuery, context.request.query, "query");
  if (!query.ok) return query.response;
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const rows = await mail.listThreadMessages(params.value.threadId, query.value.order ?? "asc");
  if (rows.length === 0) return notFound("Thread");
  const accounts = await accountsOf(request);
  const mailboxes = await mail.listMailboxRows(accounts.map((account) => account.accountId));
  const accountIds = accountIdsByMailbox(mailboxes);
  const owned = rows.filter((row) => accountIds.has(row.mailboxId));
  if (owned.length === 0) return notFound("Thread");
  return ok({ items: owned.map((row) => toThreadMessageResponse(row, accountIds)) });
};

const listMailboxes: Handler = async (context, request) => {
  const params = parse(accountParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const account = await accountOf(request, params.value.accountId);
  if (account === undefined) return notFound("Account");
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxRows([
    account.accountId,
  ]);
  return ok({ items: mailboxes.map(toMailboxResponse) });
};

export const threadHandlers = {
  MailboxOperations_listMailboxes: listMailboxes,
  ThreadOperations_listThreads: mailboxThreads(listQuery),
  ThreadOperations_searchThreads: mailboxThreads(searchQuery),
  UnifiedThreadOperations_listAllThreads: listAllThreads,
  ThreadDetailOperations_listThreadMessages: listThreadMessages,
} satisfies Record<string, Handler>;

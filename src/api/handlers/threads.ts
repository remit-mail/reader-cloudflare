import type { ThreadSearchResponse } from "@remit/api-openapi-types";
import { MessageCategorySchema } from "@remit/api-zod-schemas";
import type { MailboxItem, SearchOptions } from "@remit/data-ports";
import { z } from "zod";
import type { MailAccount } from "../../mail/types";
import { tenantMail } from "../../stubs";
import {
  accountIdsByMailbox,
  inboxesOf,
  toMailboxResponse,
  toThreadMessageResponse,
} from "../mappers";
import {
  type ApiRequest,
  accountConfigOf,
  booleanParam,
  type Handler,
  limitParam,
  listParam,
  mailAccountOf,
  mailAccountsOf,
  orderParam,
  parse,
} from "../request";
import { invalid, notFound, ok, optional } from "../respond";

const DEFAULT_LIMIT = 50;

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
  (query.senderTrust !== undefined && !query.senderTrust.includes("unknown")) ||
  query.dkimMismatch === true;

const categoriesOf = (values: readonly string[] | undefined): SearchOptions["category"] =>
  values?.flatMap((value) => {
    const category = MessageCategorySchema.safeParse(value);
    return category.success ? [category.data] : [];
  });

const searchOptionsOf = (query: SearchQuery): SearchOptions => ({
  ...optional("query", text(query.query)),
  ...optional("subject", text(query.subject)),
  ...optional("from", text(query.from)),
  ...optional("unread", query.unread),
  ...optional("starred", query.starred),
  ...optional("attachments", query.attachments),
  ...optional("muted", query.muted),
  ...optional("category", categoriesOf(query.category)),
});

const respondThreads = async (
  request: ApiRequest,
  accounts: readonly MailAccount[],
  scope: readonly MailboxItem[] | null,
  query: SearchQuery,
): Promise<Response> => {
  const accountConfigId = accountConfigOf(accounts);
  if (excludesAll(query) || accountConfigId === null) {
    const empty: ThreadSearchResponse = { items: [], ...optional("count", query.count ? 0 : null) };
    return ok(empty);
  }
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const page = await mail.searchThreads({
    accountConfigId,
    mailboxIds: scope === null ? null : scope.map((mailbox) => mailbox.mailboxId),
    search: searchOptionsOf(query),
    order: query.order ?? "desc",
    continuationToken: query.continuationToken ?? null,
    limit: query.limit ?? DEFAULT_LIMIT,
    results: query.results !== false,
    count: query.count === true,
  });
  if (!page.ok) return invalid(`continuationToken cannot be decoded: ${page.reason}`);
  const accountIds = accountIdsByMailbox(
    await mail.listMailboxItems(accounts.map((account) => account.accountId)),
  );
  const body: ThreadSearchResponse = {
    ...optional(
      "items",
      page.value.rows?.map((row) => toThreadMessageResponse(row, accountIds)),
    ),
    ...optional("continuationToken", page.value.continuationToken),
    ...optional("count", page.value.count),
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
    const mailbox = await tenantMail(request.env, request.tenant.tenantId).findMailbox(
      params.value.mailboxId,
    );
    if (mailbox === null) return notFound("Mailbox");
    const account = await mailAccountOf(request, mailbox.accountId);
    if (account === undefined) return notFound("Mailbox");
    return respondThreads(request, [account], [mailbox], query.value);
  };

const scopeMailboxes = (
  mailboxes: readonly MailboxItem[],
  query: SearchQuery,
  everyAccount: boolean,
): readonly MailboxItem[] | null => {
  if (query.mailboxId !== undefined) {
    return mailboxes.filter((mailbox) => mailbox.mailboxId === query.mailboxId);
  }
  if (query.starred === true || text(query.query) !== null) {
    return everyAccount ? null : mailboxes;
  }
  return inboxesOf(mailboxes);
};

const listAllThreads: Handler = async (context, request) => {
  const query = parse(allThreadsQuery, context.request.query, "query");
  if (!query.ok) return query.response;
  const everyAccount = query.value.accountId === undefined;
  const accounts = (await mailAccountsOf(request)).filter(
    (account) => everyAccount || account.accountId === query.value.accountId,
  );
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxItems(
    accounts.map((account) => account.accountId),
  );
  return respondThreads(
    request,
    accounts,
    scopeMailboxes(mailboxes, query.value, everyAccount),
    query.value,
  );
};

const listThreadMessages: Handler = async (context, request) => {
  const params = parse(threadParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const query = parse(listQuery, context.request.query, "query");
  if (!query.ok) return query.response;
  const accounts = await mailAccountsOf(request);
  const accountConfigId = accountConfigOf(accounts);
  if (accountConfigId === null) return notFound("Thread");
  const mail = tenantMail(request.env, request.tenant.tenantId);
  const rows = await mail.listThreadMessages(
    accountConfigId,
    params.value.threadId,
    query.value.order ?? "asc",
  );
  const accountIds = accountIdsByMailbox(
    await mail.listMailboxItems(accounts.map((account) => account.accountId)),
  );
  const owned = rows.filter((row) => accountIds.has(row.mailboxId));
  if (owned.length === 0) return notFound("Thread");
  return ok({ items: owned.map((row) => toThreadMessageResponse(row, accountIds)) });
};

const listMailboxes: Handler = async (context, request) => {
  const params = parse(accountParams, context.request.params, "path");
  if (!params.ok) return params.response;
  const account = await mailAccountOf(request, params.value.accountId);
  if (account === undefined) return notFound("Account");
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxes([account]);
  return ok({ items: mailboxes.map(toMailboxResponse) });
};

export const threadHandlers = {
  MailboxOperations_listMailboxes: listMailboxes,
  ThreadOperations_listThreads: mailboxThreads(listQuery),
  ThreadOperations_searchThreads: mailboxThreads(searchQuery),
  UnifiedThreadOperations_listAllThreads: listAllThreads,
  ThreadDetailOperations_listThreadMessages: listThreadMessages,
} satisfies Record<string, Handler>;

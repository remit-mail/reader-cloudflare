import { z } from "zod";
import type { Tenant } from "../access";
import type { Env } from "../env";
import { log } from "../log";
import { resolveAccount, tenantMail } from "../mail/routes";
import type { MessageView } from "../mail/types";

const SEARCH_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/search$/;

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  mailboxId: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .nullable()
    .default(null),
});

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

const matchAccountId = (path: string): string | null => SEARCH_PATH.exec(path)?.[1] ?? null;

export const tenantSearch = (env: Env, tenantId: string) =>
  env.TENANT_SEARCH.get(env.TENANT_SEARCH.idFromName(tenantId));

export const isSearchPath = (path: string): boolean => matchAccountId(path) !== null;

export const searchApi = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  const accountId = matchAccountId(path);
  if (accountId === null || request.method !== "GET") return notFound();
  const account = await resolveAccount(env, tenant, accountId);
  if (account === null) return notFound();
  const url = new URL(request.url);
  const query = searchQuery.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    mailboxId: url.searchParams.get("mailboxId") ?? undefined,
  });
  if (!query.success) {
    return Response.json({ error: "invalid query", issues: query.error.issues }, { status: 400 });
  }
  const started = Date.now();
  const hits = await tenantSearch(env, tenant.tenantId).search(account, {
    query: query.data.q,
    limit: query.data.limit,
    mailboxId: query.data.mailboxId,
  });
  const mail = tenantMail(env, tenant.tenantId);
  const results = await Promise.all(hits.map((hit) => mail.getMessage(account, hit.messageId)));
  const messages = results.flatMap((result): MessageView[] => (result.ok ? [result.value] : []));
  log.info("search", {
    tenantId: tenant.tenantId,
    accountId: account.accountId,
    hits: hits.length,
    returned: messages.length,
    durationMs: Date.now() - started,
  });
  return Response.json({ messages });
};

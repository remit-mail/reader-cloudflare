import { z } from "zod";
import type { Tenant } from "../access";
import { getAccount } from "../db/accounts";
import { openAppDb } from "../db/client";
import type { Env } from "../env";
import { log } from "../log";
import type { ListMessagesOptions } from "./tenant-mail";
import type { MailAccount } from "./types";

const MAILBOXES_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/mailboxes$/;
const MESSAGES_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/mailboxes\/([a-z0-9]+)\/messages$/;
const MESSAGE_PATH = /^\/api\/accounts\/([A-Za-z0-9]+)\/messages\/([a-z0-9]+)$/;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^-?\d+:[a-z0-9]+$/)
    .transform((value) => {
      const separator = value.indexOf(":");
      return {
        sentDate: Number(value.slice(0, separator)),
        messageId: value.slice(separator + 1),
      };
    })
    .nullable()
    .default(null),
});

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

type MailRoute =
  | { readonly kind: "mailboxes"; readonly accountId: string }
  | { readonly kind: "messages"; readonly accountId: string; readonly mailboxId: string }
  | { readonly kind: "message"; readonly accountId: string; readonly messageId: string };

const matchRoute = (path: string): MailRoute | null => {
  const mailboxes = MAILBOXES_PATH.exec(path);
  if (mailboxes?.[1] !== undefined) return { kind: "mailboxes", accountId: mailboxes[1] };
  const list = MESSAGES_PATH.exec(path);
  if (list?.[1] !== undefined && list[2] !== undefined) {
    return { kind: "messages", accountId: list[1], mailboxId: list[2] };
  }
  const message = MESSAGE_PATH.exec(path);
  if (message?.[1] !== undefined && message[2] !== undefined) {
    return { kind: "message", accountId: message[1], messageId: message[2] };
  }
  return null;
};

export const tenantMail = (env: Env, tenantId: string) =>
  env.TENANT_MAIL.get(env.TENANT_MAIL.idFromName(tenantId));

const resolveAccount = async (
  env: Env,
  tenant: Tenant,
  accountId: string,
): Promise<MailAccount | null> => {
  const account = await getAccount(openAppDb(env.DB), tenant.tenantId, accountId);
  if (account === undefined) return null;
  return { tenantId: tenant.tenantId, accountId, accountConfigId: account.accountConfigId };
};

const listMessages = async (
  env: Env,
  account: MailAccount,
  mailboxId: string,
  url: URL,
): Promise<Response> => {
  const query = listQuery.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
  });
  if (!query.success) {
    return Response.json({ error: "invalid query", issues: query.error.issues }, { status: 400 });
  }
  const options: ListMessagesOptions = query.data;
  const result = await tenantMail(env, account.tenantId).listMessages(account, mailboxId, options);
  if (!result.ok) return notFound();
  return Response.json(result.value);
};

export const isMailPath = (path: string): boolean => matchRoute(path) !== null;

export const mailApi = async (
  request: Request,
  env: Env,
  path: string,
  tenant: Tenant,
): Promise<Response> => {
  const route = matchRoute(path);
  if (route === null || request.method !== "GET") return notFound();
  const account = await resolveAccount(env, tenant, route.accountId);
  if (account === null) return notFound();
  log.info("mail read", {
    tenantId: tenant.tenantId,
    accountId: account.accountId,
    route: route.kind,
  });
  if (route.kind === "mailboxes") {
    return Response.json(await tenantMail(env, tenant.tenantId).listMailboxes(account));
  }
  if (route.kind === "messages") {
    return listMessages(env, account, route.mailboxId, new URL(request.url));
  }
  const result = await tenantMail(env, tenant.tenantId).getMessage(account, route.messageId);
  if (!result.ok) return notFound();
  return Response.json(result.value);
};

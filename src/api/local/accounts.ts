import { env } from "cloudflare:workers";
import type { ConfigDescriptionResponse } from "@remit/api-openapi-types";
import { CreateAccountInputSchema } from "@remit/api-zod-schemas";
import type { HandlerContext } from "@remit/backend/serve";
import type { AccountConfigItem, AccountItem, MailboxItem } from "@remit/data-ports";
import { BadRequestError, ConflictError, NotFoundError } from "@remit/data-ports/errors";
import { generateBase36Id } from "@remit/drizzle-sqlite-schema";
import type { Context } from "openapi-backend";
import { z } from "zod";
import { commit } from "../../commit";
import { sealPassword } from "../../crypto/envelope";
import { toMailAccount } from "../../db/settings";
import { currentCorrelationId, log } from "../../log";
import { accountSync } from "../../stubs";
import { toAccountConfigResponse, toAccountResponse } from "./responses";

export const accountParams = z.object({ accountId: z.string().min(1) });

const ensureAccountConfig = async (ctx: HandlerContext): Promise<AccountConfigItem> => {
  const { accountConfigId } = ctx.identity;
  const [existing] = await ctx.client.accountConfig.get([accountConfigId]);
  if (existing !== undefined) return existing;
  const created = await ctx.client.accountConfig
    .create({ accountConfigId, userId: accountConfigId })
    .catch((error: unknown) => {
      if (error instanceof ConflictError) return ctx.client.accountConfig.get(accountConfigId);
      throw error;
    });
  log.info("account config created", { tenantId: ctx.identity.sub, accountConfigId });
  return created;
};

export const accountsOf = async (ctx: HandlerContext): Promise<AccountItem[]> => {
  const accounts = await ctx.client.account.listAllByAccountConfig(ctx.identity.accountConfigId);
  return accounts
    .filter((account) => account.deletedAt === undefined)
    .sort((left, right) => left.createdAt - right.createdAt);
};

export const ownedAccount = async (
  ctx: HandlerContext,
  accountId: string,
): Promise<AccountItem> => {
  const [account] = await ctx.client.account.get([accountId]);
  if (
    account === undefined ||
    account.deletedAt !== undefined ||
    account.accountConfigId !== ctx.identity.accountConfigId
  ) {
    throw new NotFoundError("Account not found");
  }
  return account;
};

const mailboxesOf = async (
  ctx: HandlerContext,
  accounts: readonly AccountItem[],
): Promise<MailboxItem[]> =>
  (
    await Promise.all(
      accounts.map((account) => ctx.client.mailbox.listAllByAccount(account.accountId)),
    )
  ).flat();

export const startSync = (ctx: HandlerContext, account: AccountItem) =>
  accountSync(env, ctx.identity.sub, account.accountId).start(
    toMailAccount(ctx.identity.sub, account),
    currentCorrelationId(),
  );

const getConfig = async (_context: Context, ctx: HandlerContext) => {
  const config = await ensureAccountConfig(ctx);
  const accounts = await accountsOf(ctx);
  const mailboxes = await mailboxesOf(ctx, accounts);
  const body: ConfigDescriptionResponse = {
    accountConfig: toAccountConfigResponse(config),
    accounts: accounts.map((account) => toAccountResponse(account, mailboxes)),
    buildCommit: commit,
  };
  return body;
};

const createAccount = async (context: Context, ctx: HandlerContext) => {
  const input = CreateAccountInputSchema.parse(context.request.requestBody);
  if (input.authType !== undefined && input.authType !== "password") {
    throw new BadRequestError("Only password accounts can be added here");
  }
  if (input.password === undefined || input.password === "") {
    throw new BadRequestError("A password is required");
  }
  const tenantId = ctx.identity.sub;
  const config = await ensureAccountConfig(ctx);
  const username = input.username ?? input.email;
  const smtpHost = input.smtpHost ?? "";
  const account = await ctx.client.account.create({
    accountId: generateBase36Id(),
    accountConfigId: config.accountConfigId,
    username,
    email: input.email,
    authType: "password",
    passwordHash: await sealPassword(ctx.client.secrets, input.password),
    syncedServices: ["Mail"],
    grantedScopes: [],
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapTls: input.imapTls,
    imapStartTls: input.imapStartTls,
    smtpEnabled: input.smtpEnabled ?? smtpHost !== "",
    smtpHost,
    smtpPort: input.smtpPort ?? 587,
    smtpTls: input.smtpTls ?? false,
    smtpStartTls: input.smtpStartTls ?? true,
    smtpUsername: input.smtpUsername ?? username,
    isActive: true,
    connectionState: "not_authenticated",
    syncPhase: "idle",
  });
  log.info("account created", { tenantId, accountId: account.accountId });
  await startSync(ctx, account);
  return toAccountResponse(account, []);
};

export const accountHandlers = {
  ConfigOperations_getConfig: getConfig,
  AccountOperations_createAccount: createAccount,
};

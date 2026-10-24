import type { ConfigDescriptionResponse, TestConnectionResponse } from "@remit/api-openapi-types";
import { CreateAccountInputSchema, TestConnectionInputSchema } from "@remit/api-zod-schemas";
import { createAccount, decryptCredential, ensureAccountConfig } from "../../db/accounts";
import { openAppDb } from "../../db/client";
import { log } from "../../log";
import type { ImapCredential } from "../../mail/imap-connect";
import { settle, verifyImap, verifySmtp } from "../../mail/send";
import { tenantMail } from "../../stubs";
import { toAccountConfigResponse, toAccountResponse } from "../mappers";
import { type ApiRequest, accountOf, accountsOf, type Handler, parse } from "../request";
import { invalid, notFound, ok, optional } from "../respond";

const getConfig: Handler = async (_context, request) => {
  const db = openAppDb(request.env.DB);
  const config = await ensureAccountConfig(db, request.tenant.tenantId);
  const accounts = await accountsOf(request);
  const mailboxes = await tenantMail(request.env, request.tenant.tenantId).listMailboxRows(
    accounts.map((account) => account.accountId),
  );
  const body: ConfigDescriptionResponse = {
    accountConfig: toAccountConfigResponse(config),
    accounts: accounts.map((account) => toAccountResponse(account, mailboxes)),
    semanticSearchEnabled: false,
  };
  return ok(body);
};

const createAccountHandler: Handler = async (_context, request) => {
  const parsed = parse(CreateAccountInputSchema, request.body, "account");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  if (input.authType !== undefined && input.authType !== "password") {
    return invalid("Only password accounts can be added here");
  }
  if (input.password === undefined || input.password === "") {
    return invalid("A password is required");
  }
  const db = openAppDb(request.env.DB);
  const account = await createAccount(request.env, db, request.tenant.tenantId, {
    input,
    password: input.password,
  });
  log.info("account created", { tenantId: request.tenant.tenantId, accountId: account.accountId });
  return ok(toAccountResponse(account, []));
};

const storedPassword = async (
  request: ApiRequest,
  accountId: string | undefined,
): Promise<string | null> => {
  if (accountId === undefined) return null;
  const account = await accountOf(request, accountId);
  if (account === undefined) return null;
  const secret = await decryptCredential(
    request.env,
    openAppDb(request.env.DB),
    request.tenant.tenantId,
    accountId,
  );
  return secret.ok ? secret.plaintext : null;
};

const testConnection: Handler = async (_context, request) => {
  const parsed = parse(TestConnectionInputSchema, request.body, "connection settings");
  if (!parsed.ok) return parsed.response;
  const input = parsed.value;
  const password = input.password ?? (await storedPassword(request, input.accountId));
  if (password === null) {
    return input.accountId === undefined
      ? invalid("A password is required")
      : notFound("Account credential");
  }
  const imap: ImapCredential = {
    host: input.imapHost,
    port: input.imapPort,
    secure: input.imapTls,
    username: input.username,
    password,
  };
  const imapResult = await settle(verifyImap(imap));
  const smtpHost = input.smtpHost;
  const smtpResult =
    smtpHost === undefined || smtpHost === ""
      ? null
      : await settle(
          verifySmtp({
            host: smtpHost,
            port: input.smtpPort ?? 587,
            secure: input.smtpTls ?? false,
            username: input.smtpUsername ?? input.username,
            password: input.smtpPassword ?? password,
          }),
        );
  log.info("connection tested", {
    tenantId: request.tenant.tenantId,
    imapHost: input.imapHost,
    imap: imapResult.ok,
    smtp: smtpResult?.ok ?? null,
  });
  const body: TestConnectionResponse = {
    imapSuccess: imapResult.ok,
    ...optional("imapError", imapResult.ok ? null : imapResult.reason),
    ...optional("smtpSuccess", smtpResult?.ok),
    ...optional("smtpError", smtpResult === null || smtpResult.ok ? null : smtpResult.reason),
  };
  return ok(body);
};

export const configHandlers = {
  ConfigOperations_getConfig: getConfig,
  AccountOperations_createAccount: createAccountHandler,
  AccountOperations_testConnection: testConnection,
} satisfies Record<string, Handler>;

import type { AccountItem } from "@remit/data-ports";
import type { Context } from "openapi-backend";
import { z } from "zod";
import type { Tenant } from "../access";
import { listTenantAccounts, type SettingsRepositories, toMailAccount } from "../db/settings";
import type { Env } from "../env";
import type { MailAccount } from "../mail/types";
import { invalid } from "./respond";

export interface ApiRequest {
  readonly env: Env;
  readonly tenant: Tenant;
  readonly settings: SettingsRepositories;
  readonly origin: string;
  readonly body: unknown;
}

export type Handler = (context: Context, request: ApiRequest) => Promise<Response>;

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

export const parse = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  what: string,
): Parsed<T> => {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, response: invalid(`Invalid ${what}`, result.error.issues) };
};

export const booleanParam = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

export const orderParam = z.enum(["asc", "desc"]).optional();

export const limitParam = z.coerce.number().int().min(1).max(200).optional();

export const listParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? value.split(",") : value))
  .optional();

export const accountsOf = (request: ApiRequest): Promise<AccountItem[]> =>
  listTenantAccounts(request.settings, request.tenant);

export const accountOf = async (
  request: ApiRequest,
  accountId: string,
): Promise<AccountItem | undefined> =>
  (await accountsOf(request)).find((account) => account.accountId === accountId);

export const mailAccountsOf = async (request: ApiRequest): Promise<MailAccount[]> =>
  (await accountsOf(request)).map((account) => toMailAccount(request.tenant.tenantId, account));

export const mailAccountOf = async (
  request: ApiRequest,
  accountId: string,
): Promise<MailAccount | undefined> => {
  const account = await accountOf(request, accountId);
  return account === undefined ? undefined : toMailAccount(request.tenant.tenantId, account);
};

export const accountConfigOf = (accounts: readonly MailAccount[]): string | null => {
  const configs = [...new Set(accounts.map((account) => account.accountConfigId))];
  if (configs.length > 1) throw new Error(`tenant accounts span ${configs.length} account configs`);
  return configs[0] ?? null;
};

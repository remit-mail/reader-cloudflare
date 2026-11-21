import type { UserSettingsResponse } from "@remit/api-openapi-types";
import type { ClassificationView } from "../../../src/operator-settings-contract";

const RAW = Symbol("raw");

export interface Html {
  readonly [RAW]: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"'`]/g, (char) => ESCAPES[char] ?? char);

const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && RAW in value;

const render = (value: unknown): string => {
  if (isHtml(value)) return value[RAW];
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
};

export const html = (strings: TemplateStringsArray, ...values: unknown[]): Html => ({
  [RAW]: strings.reduce(
    (out, part, index) => out + part + (index < values.length ? render(values[index]) : ""),
    "",
  ),
});

export const toResponse = (page: Html, status = 200): Response =>
  new Response(page[RAW], {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

const ISSUES_URL = "https://github.com/remit-mail/reader-cloudflare/issues/new";

const layout = (title: string, body: Html): Html => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/login.css" />
    <script type="module" src="/admin.js"></script>
  </head>
  <body>
    <main class="page wide">
      <header class="brand"><span class="mark">remit</span> <span class="muted">admin</span></header>
      <div id="banner" class="banner" role="status" hidden data-issues="${ISSUES_URL}"></div>
      ${body}
    </main>
  </body>
</html>`;

export type UserState = "invited" | "expired" | "active" | "disabled";

export interface AdminUser {
  readonly userId: string | null;
  readonly email: string;
  readonly state: UserState;
  readonly passkeys: number;
  readonly app: boolean;
  readonly sessions: number;
  readonly lastSignIn: number | null;
}

const when = (at: number | null): string => (at === null ? "never" : new Date(at).toISOString());

const actionForm = (action: string, targetEmail: string, label: string, danger = false): Html =>
  html`<form method="post" action="/app/admin/action" class="admin-action" data-action="${action}" data-target="${targetEmail}">
    <button type="submit" class="${danger ? "button danger" : "button"}">${label}</button>
  </form>`;

const userRow = (user: AdminUser, operator: boolean): Html => html`<tr>
  <td>${user.email}</td>
  <td>${user.state === "expired" ? "invite expired" : user.state}</td>
  <td>${user.passkeys}</td>
  <td>${user.app ? "on" : "off"}</td>
  <td>${user.sessions}</td>
  <td>${when(user.lastSignIn)}</td>
  <td class="actions">
    ${
      operator
        ? html`<span class="muted">operator</span>`
        : user.state === "invited" || user.state === "expired"
          ? actionForm("RevokeInvite", user.email, "Revoke invite", true)
          : [
              user.state === "disabled"
                ? actionForm("Enable", user.email, "Enable")
                : actionForm("Disable", user.email, "Disable", true),
              actionForm("ResetFactors", user.email, "Reset factors", true),
              actionForm("SignOutEverywhere", user.email, "Sign out everywhere"),
            ]
    }
  </td>
</tr>`;

export type ClassificationRead =
  | { readonly ok: true; readonly view: ClassificationView }
  | { readonly ok: false; readonly message: string };

const DEFAULT_DAILY_LIMIT = 500;

const classificationFailure = (message: string): Html => {
  const report = `${ISSUES_URL}?${new URLSearchParams({ title: "remit admin classifier default did not load", body: message }).toString()}`;
  return html`<section class="card">
    <h2>Classifier default</h2>
    <div class="banner danger" role="alert">
      <p>The classifier default did not load: ${message}</p>
      <a href="${report}" target="_blank" rel="noreferrer">Report an issue</a>
    </div>
  </section>`;
};

const classificationSection = (operatorEmail: string, view: ClassificationView): Html => {
  const configured = view.state === "Configured" ? view : null;
  const summary = configured
    ? `Version ${configured.version}, set by ${configured.updatedBy} at ${when(configured.updatedAt)}. This overrides the deployment classifier default.`
    : "No operator override is set. The deployment classifier default is in use.";
  return html`<section class="card">
    <h2>Classifier default</h2>
    <p class="muted">${summary}</p>
    <form method="post" action="/app/admin/action" class="admin-action classification" data-action="SetClassification" data-target="${operatorEmail}">
      <label for="classification-preset">Preset</label>
      <select id="classification-preset" name="presetId" required>
        ${view.presets.map(
          (preset) =>
            html`<option value="${preset.presetId}" ${configured?.presetId === preset.presetId && html`selected`}>${preset.label}</option>`,
        )}
      </select>
      <label for="classification-model">Model</label>
      <input id="classification-model" name="model" type="text" autocomplete="off" value="${configured?.model ?? ""}" placeholder="the preset model" />
      <label for="classification-base-url">Base URL</label>
      <input id="classification-base-url" name="baseUrl" type="url" autocomplete="off" value="${configured?.baseUrl ?? ""}" placeholder="the preset base URL" />
      <label for="classification-api-key">API key</label>
      <input id="classification-api-key" name="apiKey" type="password" autocomplete="off" placeholder="${configured?.hasKey ? "unchanged" : ""}" />
      <label for="classification-daily-limit">Daily limit per account</label>
      <input id="classification-daily-limit" name="dailyLimit" type="number" min="1" step="1" required value="${configured?.dailyLimit ?? DEFAULT_DAILY_LIMIT}" />
      <label><input name="enabled" type="checkbox" ${(configured === null || configured.enabled) && html`checked`} /> Classify mail with it</label>
      <button type="submit" class="button primary">Save classifier</button>
    </form>
    ${
      configured &&
      actionForm("ClearClassification", operatorEmail, "Use deployment classifier default", true)
    }
  </section>`;
};

export interface TenantClassificationRead {
  readonly ok: true;
  readonly userId: string;
  readonly email: string;
  readonly settings: UserSettingsResponse;
}

const tenantClassificationForm = (tenant: TenantClassificationRead): Html => {
  const { classification } = tenant.settings;
  const configured = classification.state === "Configured" ? classification : null;
  const selected = classification.state === "NotConfigured" ? null : classification.presetId;
  const hasKey = configured !== null && configured.sources.apiKey !== "Default";
  return html`<details>
    <summary>${tenant.email}</summary>
    <form method="post" action="/app/admin/action" class="admin-action classification" data-action="SetTenantClassification" data-target="${tenant.email}">
      <label for="tenant-${tenant.userId}-preset">Preset</label>
      <select id="tenant-${tenant.userId}-preset" name="presetId" required>
        ${tenant.settings.classificationPresets.map(
          (preset) =>
            html`<option value="${preset.presetId}" ${selected === preset.presetId && html`selected`}>${preset.label}</option>`,
        )}
      </select>
      <label for="tenant-${tenant.userId}-model">Model</label>
      <input id="tenant-${tenant.userId}-model" name="model" type="text" autocomplete="off" value="${configured?.model ?? ""}" placeholder="the preset model" />
      <label for="tenant-${tenant.userId}-base-url">Base URL</label>
      <input id="tenant-${tenant.userId}-base-url" name="baseUrl" type="url" autocomplete="off" value="${configured?.baseUrl ?? ""}" placeholder="the preset base URL" />
      <label for="tenant-${tenant.userId}-api-key">API key</label>
      <input id="tenant-${tenant.userId}-api-key" name="apiKey" type="password" autocomplete="off" placeholder="${hasKey ? "unchanged" : ""}" />
      <label for="tenant-${tenant.userId}-daily-limit">Daily limit per account</label>
      <input id="tenant-${tenant.userId}-daily-limit" name="dailyLimit" type="number" min="1" step="1" required value="${configured?.dailyLimit ?? DEFAULT_DAILY_LIMIT}" />
      <label><input name="enabled" type="checkbox" ${configured?.enabled && html`checked`} /> Classify mail with it</label>
      <button type="submit" class="button primary">Save classifier</button>
    </form>
    ${
      classification.state !== "NotConfigured" &&
      actionForm("ClearTenantClassification", tenant.email, "Clear this person's classifier", true)
    }
  </details>`;
};

export const adminPage = (
  operatorEmail: string,
  users: readonly AdminUser[],
  classification: ClassificationRead,
  tenants: readonly TenantClassificationRead[],
  isOperator: (email: string) => boolean,
): Html =>
  layout(
    "remit admin",
    html`<section class="card">
      <h1>People</h1>
      <form method="post" action="/app/admin/action" class="admin-action invite" data-action="Invite">
        <label for="invite-email">Email</label>
        <input id="invite-email" name="targetEmail" type="email" required autocomplete="off" />
        <button type="submit" class="button primary">Invite</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Email</th><th>State</th><th>Passkeys</th><th>App</th><th>Sessions</th><th>Last sign-in</th><th></th></tr>
          </thead>
          <tbody>${users.map((user) => userRow(user, isOperator(user.email)))}</tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <h2>Signing keys</h2>
      <p class="muted">Rotate starts a new key and keeps the old one for two days. Revoke deletes every key and signs everyone out.</p>
      <div class="row">
        ${actionForm("RotateKeys", operatorEmail, "Rotate signing keys")}
        ${actionForm("RevokeKeys", operatorEmail, "Revoke signing keys", true)}
      </div>
      <p><a href="/admin/audit?days=7">Audit log</a></p>
    </section>
    ${
      classification.ok
        ? classificationSection(operatorEmail, classification.view)
        : classificationFailure(classification.message)
    }
    <section class="card">
      <h2>Tenant classifiers</h2>
      <p class="muted">Settings and keys saved for people who have opened remit.</p>
      ${tenants.length === 0 ? html`<p class="muted">No tenant exists yet.</p>` : tenants.map(tenantClassificationForm)}
    </section>`,
  );

export const enrollPage = (): Html =>
  layout(
    "remit admin",
    html`<section class="card">
      <h1>Add a second factor</h1>
      <p>Add a passkey or an authenticator app on the Security page first.</p>
      <p><a class="button primary" href="/security">Open Security</a></p>
    </section>`,
  );

export interface AuditView {
  readonly at: number;
  readonly actor: string;
  readonly email: string;
  readonly address: string;
  readonly event: string;
  readonly outcome: string;
  readonly clientId: string;
}

export const auditPage = (days: number, rows: readonly AuditView[]): Html =>
  layout(
    "remit audit",
    html`<section class="card">
      <h1>Audit, last ${days} days</h1>
      <p><a href="/admin">Back to people</a></p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>At</th><th>Actor</th><th>Email</th><th>Address</th><th>Event</th><th>Outcome</th><th>Client</th></tr>
          </thead>
          <tbody>${rows.map(
            (row) =>
              html`<tr><td>${new Date(row.at).toISOString()}</td><td>${row.actor}</td><td>${row.email}</td><td>${row.address}</td><td>${row.event}</td><td>${row.outcome}</td><td>${row.clientId}</td></tr>`,
          )}</tbody>
        </table>
      </div>
    </section>`,
  );

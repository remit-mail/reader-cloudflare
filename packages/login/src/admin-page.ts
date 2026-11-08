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

export const adminPage = (
  operatorEmail: string,
  users: readonly AdminUser[],
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

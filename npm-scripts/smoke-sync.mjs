import { appApi } from "./app-api.mjs";
import { readEnvFile, TEST_ACCOUNT_ENV } from "./env.mjs";

const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;

const test = readEnvFile(TEST_ACCOUNT_ENV);
for (const name of [
  "TEST_IMAP_HOST",
  "TEST_IMAP_PORT",
  "TEST_IMAP_SECURE",
  "TEST_IMAP_USER",
  "TEST_IMAP_PASSWORD",
]) {
  if (!test[name]) {
    console.error(`${TEST_ACCOUNT_ENV} does not set ${name}`);
    process.exit(1);
  }
}

const imapSecure = test.TEST_IMAP_SECURE === "true";
const smtpSecure = test.TEST_SMTP_SECURE === "true";
const smtp =
  test.TEST_SMTP_HOST === undefined
    ? {}
    : {
        smtpHost: test.TEST_SMTP_HOST,
        smtpPort: Number(test.TEST_SMTP_PORT),
        smtpTls: smtpSecure,
        smtpStartTls: !smtpSecure,
        smtpUsername: test.TEST_SMTP_USER ?? test.TEST_IMAP_USER,
        smtpPassword: test.TEST_SMTP_PASSWORD ?? test.TEST_IMAP_PASSWORD,
      };
const connection = {
  username: test.TEST_IMAP_USER,
  password: test.TEST_IMAP_PASSWORD,
  imapHost: test.TEST_IMAP_HOST,
  imapPort: Number(test.TEST_IMAP_PORT),
  imapTls: imapSecure,
  imapStartTls: !imapSecure,
  ...smtp,
};

const request = appApi();
const call = async (step, method, path, body) => {
  const response = await request(method, path, body);
  const code =
    typeof response.body === "object" && response.body !== null
      ? (response.body.code ?? response.body.error ?? "")
      : "";
  console.log(`${step}: ${response.status} ${response.ms}ms ${code}`.trimEnd());
  if (!response.ok) process.exit(1);
  return response.body;
};

const started = Date.now();

const tested = await call("test-connection", "POST", "/api/accounts/test-connection", connection);
console.log(`  imap ${tested.imapSuccess ? "ok" : "failed"}, smtp ${tested.smtpSuccess ?? "-"}`);
if (!tested.imapSuccess) process.exit(1);

const config = await call("config", "GET", "/api/config");
console.log(`  accounts ${config.accounts.length}`);
const account =
  config.accounts[0] ??
  (await call("create-account", "POST", "/api/accounts", {
    email: test.TEST_EMAIL ?? test.TEST_IMAP_USER,
    authType: "password",
    smtpEnabled: test.TEST_SMTP_HOST !== undefined,
    ...connection,
  }));

const syncStarted = Date.now();
await call("trigger-sync", "POST", `/api/accounts/${account.accountId}/sync`);

const isSettled = (status) =>
  status.syncPhase === "complete" ||
  status.syncPhase === "error" ||
  (status.syncPhase === "idle" && (status.lastSyncAt ?? 0) >= syncStarted);

let status = await call("sync-status", "GET", `/api/accounts/${account.accountId}/sync/status`);
while (!isSettled(status)) {
  if (Date.now() - syncStarted > TIMEOUT_MS) {
    console.error(`sync did not settle within ${TIMEOUT_MS / 60_000} minutes`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  status = await call("sync-status", "GET", `/api/accounts/${account.accountId}/sync/status`);
}
const messagesSynced = status.mailboxes.reduce((sum, mailbox) => sum + mailbox.messagesSynced, 0);
const messagesTotal = status.mailboxes.reduce((sum, mailbox) => sum + mailbox.messagesTotal, 0);
console.log(
  `  phase ${status.syncPhase}, mailboxes ${status.mailboxCountSynced ?? "-"}/${status.mailboxCountTotal ?? status.mailboxes.length}, messages ${messagesSynced}/${messagesTotal}, ${Date.now() - syncStarted}ms`,
);
if (status.syncPhase === "error") process.exit(1);

const threads = await call("list-threads", "GET", "/api/threads?limit=25");
const items = threads.items ?? [];
console.log(`  threads ${items.length}${threads.continuationToken ? "+" : ""}`);
const first = items[0];
if (first !== undefined) {
  const thread = await call("thread-messages", "GET", `/api/threads/${first.threadId}/messages`);
  console.log(`  messages in thread ${thread.items.length}`);
  await call("describe-message", "GET", `/api/messages/${first.messageId}`);
}

console.log(`smoke:sync passed in ${Date.now() - started}ms`);

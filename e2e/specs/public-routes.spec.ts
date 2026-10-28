import { expect, test } from "@playwright/test";
import ICAL from "ical.js";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import {
  readAcceptedEnvelope,
  waitForAcceptedMessage,
} from "../.reader/packages/e2e/src/smtp-sink.js";

const RESOURCE_SCOPE_MARK = "://";

const baseUrl = (): string => {
  const url = process.env.E2E_BASE_URL;
  if (url === undefined) throw new Error("E2E_BASE_URL is not set; run `npm run e2e`");
  return url;
};

type Json = <T>(method: string, path: string, body?: unknown) => Promise<T>;

// Every call names its own dev identity, so a spec starts from a tenant no
// earlier request has created.
const freshTenant = (): Json => {
  const identity = `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@remit.test`;
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl()}/api${path}`, {
      method,
      headers: {
        "x-dev-identity": identity,
        origin: baseUrl(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  };
};

interface ListedMailbox {
  readonly fullPath: string;
}

interface ConfiguredAccount {
  readonly accountId: string;
  readonly email: string;
  readonly syncedServices: readonly string[];
}

const summariesOf = (ical: string): string[] =>
  new ICAL.Component(ICAL.parse(ical))
    .getAllSubcomponents("vevent")
    .map((event) => String(event.getFirstPropertyValue("summary")));

test.describe("public routes", () => {
  test("a fresh tenant's feed, minted before any account, serves its events with no Access session", async () => {
    const json = freshTenant();
    const stamp = Date.now();
    const calendar = await json<{ calendarId: string }>("POST", "/calendars", {
      displayName: "Public feed",
      urlSegment: `public-feed-${stamp}`,
    });
    const summary = `Feed event ${stamp}`;
    await json("POST", "/calendar-events", {
      calendarId: calendar.calendarId,
      summary,
      start: "2026-11-02T09:00:00+01:00",
      end: "2026-11-02T10:00:00+01:00",
    });
    const feed = await json<{ feedToken: string }>("PUT", `/calendars/${calendar.calendarId}/feed`);

    const response = await fetch(`${baseUrl()}/api/feeds/calendar/${feed.feedToken}.ics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(summariesOf(await response.text())).toContain(summary);
  });

  test("a feed address no calendar holds answers 404", async () => {
    const unknown = "A".repeat(43);

    const response = await fetch(`${baseUrl()}/api/feeds/calendar/${unknown}.ics`);

    expect(response.status).toBe(404);
  });

  test("a fresh tenant whose first action is the Microsoft connect completes it, and it syncs and sends", async () => {
    const json = freshTenant();
    const email = `outlook-${Date.now()}@outlook.test`;
    const started = await json<{ authorizationUrl: string }>(
      "POST",
      "/accounts/oauth/microsoft/start",
      { email, services: ["Mail"] },
    );
    const authorize = new URL(started.authorizationUrl);
    const granted = (authorize.searchParams.get("scope") ?? "")
      .split(" ")
      .filter((scope) => scope.includes(RESOURCE_SCOPE_MARK));
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set(
      "code",
      Buffer.from(JSON.stringify({ scope: granted.join(" "), email })).toString("base64url"),
    );
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");

    const response = await fetch(callback, { redirect: "manual" });

    expect(response.status).toBe(302);
    const landing = new URL(response.headers.get("location") ?? "");
    expect(landing.searchParams.get("oauthError")).toBeNull();
    const accountId = landing.searchParams.get("connected");
    expect(accountId).toBeTruthy();
    const config = await json<{ accounts: ConfiguredAccount[] }>("GET", "/config");
    const account = config.accounts.find((candidate) => candidate.accountId === accountId);
    expect(account?.email).toBe(email);
    expect(account?.syncedServices).toEqual(["Mail"]);
    const mailboxes = await waitFor(
      () =>
        json<{ items?: ListedMailbox[] }>("GET", `/accounts/${accountId}/mailboxes`).then(
          (page) => page.items ?? [],
        ),
      (listed) => listed.some((mailbox) => mailbox.fullPath === "INBOX"),
      { what: "the Outlook account's mailbox listing" },
    );
    expect(mailboxes.map((mailbox) => mailbox.fullPath)).toContain("INBOX");
    const subject = `Sent over Outlook OAuth ${Date.now()}`;
    await json("POST", "/outbox", {
      accountId,
      toAddresses: ["sender@remit.test"],
      subject,
      textBody: "Signed in with a token the fake Microsoft minted.",
      sendImmediately: true,
    });
    const accepted = await waitForAcceptedMessage(subject, { timeoutMs: 60_000 });
    expect((await readAcceptedEnvelope(accepted.id)).from).toBe(email.toLowerCase());
    await json("DELETE", `/accounts/${accountId}`);
  });

  test("a callback with a forged state lands on the sign-in error", async () => {
    const callback = new URL(`${baseUrl()}/api/accounts/oauth/microsoft/callback`);
    callback.searchParams.set("code", "unused");
    callback.searchParams.set("state", "forged.state");

    const response = await fetch(callback, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("oauthError")).toBe(
      "invalid_state",
    );
  });
});

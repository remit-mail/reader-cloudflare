import { expect, test } from "@playwright/test";
import { z } from "zod";
import { waitFor } from "../.reader/packages/e2e/src/api.js";
import { countAcceptedMessages } from "../.reader/packages/e2e/src/smtp-sink.js";
import { connectSendingAccount, mintIdentity, tenantJson, tenantRequest } from "./tenant";

const QUIET_WINDOW_MS = 30_000;

const requiredPort = (name: string): number => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set; run \`npm run e2e\``);
  return Number(value);
};

const proxied = { host: "127.0.0.1", port: requiredPort("E2E_FAULT_SMTP_PORT") };
const control = `http://127.0.0.1:${requiredPort("E2E_FAULT_SMTP_CONTROL_PORT")}`;

const proxyStateSchema = z.object({
  connections: z.number(),
  cuts: z.number(),
  dataEnds: z.number(),
  armed: z.boolean(),
});
type ProxyState = z.infer<typeof proxyStateSchema>;

const proxy = async (method: string, path: string): Promise<ProxyState> => {
  const response = await fetch(`${control}${path}`, { method });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
  return proxyStateSchema.parse(await response.json());
};

const outboxRowSchema = z.object({ status: z.string(), lastError: z.string().optional() });

interface Outcome {
  readonly status: string;
  readonly lastError?: string;
}

const outcomeOf = async (identity: string, outboxMessageId: string): Promise<Outcome> => {
  const response = await tenantRequest(identity)("GET", `/outbox/${outboxMessageId}`);
  if (response.status === 404) return { status: "filed" };
  if (!response.ok) {
    throw new Error(`GET /outbox/${outboxMessageId} failed: ${response.status}`);
  }
  return outboxRowSchema.parse(await response.json());
};

const IN_FLIGHT = new Set(["queued", "sending", "sent"]);

test.describe("SMTP faults", () => {
  test.setTimeout(240_000);

  test("a connection cut after the message is taken delivers one copy and settles the row unfiled", async () => {
    const identity = mintIdentity("chaos-smtp");
    const json = tenantJson(identity);
    const account = await connectSendingAccount(json, proxied);
    const subject = `Cut after data ${Date.now()}`;

    const armed = await proxy("POST", "/arm?after=data");
    const { outboxMessageId } = await json<{ outboxMessageId: string }>("POST", "/outbox", {
      accountId: account.accountId,
      toAddresses: ["recipient@remit.test"],
      subject,
      textBody: "The server takes this message and the client never hears it did.",
      sendImmediately: true,
    });
    const cut = await waitFor(
      () => proxy("GET", "/state"),
      (state) => state.cuts > armed.cuts,
      { timeoutMs: 60_000, what: "the proxy to cut the connection after DATA" },
    );
    expect(cut.dataEnds).toBe(armed.dataEnds + 1);

    const settled = await waitFor(
      () => outcomeOf(identity, outboxMessageId),
      (outcome) => !IN_FLIGHT.has(outcome.status),
      { timeoutMs: 120_000, what: "the outbox row to settle" },
    );
    await new Promise((quiet) => setTimeout(quiet, QUIET_WINDOW_MS));
    const final = await outcomeOf(identity, outboxMessageId);
    const copies = await countAcceptedMessages(subject);
    const submissions = (await proxy("GET", "/state")).dataEnds - armed.dataEnds;
    console.log(
      `smtp cut: ${copies} cop${copies === 1 ? "y" : "ies"} in Mailpit, ` +
        `${submissions} submission(s); settled ${settled.status}, final ${final.status}` +
        (final.lastError === undefined ? "" : ` (${final.lastError})`),
    );

    expect(copies).toBe(1);
    expect(submissions).toBe(1);
    expect(final).toEqual(settled);
    expect(final.status).toBe("unfiled");
    expect(final.lastError).toContain("may already have been delivered");
  });
});

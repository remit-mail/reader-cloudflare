import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LoginOperator } from "../src/index";
import { createUser, OPERATOR, testEnv, uniqueEmail } from "./helpers";

const loginOperator = (): LoginOperator => new LoginOperator(createExecutionContext(), testEnv);

const ensureOperator = async (): Promise<void> => {
  const row = await testEnv.DB.prepare("SELECT id FROM user WHERE email = ?")
    .bind(OPERATOR)
    .first();
  if (row === null) await createUser(OPERATOR);
};

describe("LoginOperator", () => {
  it("finds a person by email whatever its case", async () => {
    const email = uniqueEmail("person");
    await createUser(email);
    await ensureOperator();
    const login = loginOperator();

    expect(await login.isDisabled(email.toUpperCase())).toBe(false);
    expect(await login.isOperator(email)).toBe(false);
    expect(await login.isOperator(OPERATOR.toUpperCase())).toBe(true);
    expect(await login.isDisabled(uniqueEmail("stranger"))).toBe(true);

    await testEnv.DB.prepare("UPDATE user SET banned = 1 WHERE email = ?").bind(email).run();
    expect(await login.isDisabled(email)).toBe(true);
  });

  it("writes an operator audit event for the actor and target emails", async () => {
    const target = uniqueEmail("target");
    await createUser(target);
    await ensureOperator();

    await loginOperator().writeAudit({
      actorEmail: OPERATOR,
      targetEmail: target.toUpperCase(),
      address: "203.0.113.7",
      event: "SettingsUpdated",
      outcome: "Succeeded",
      clientId: "api",
    });

    const row = await testEnv.DB.prepare(
      "SELECT actor, event, outcome FROM audit_event WHERE email = ? AND client_id = 'api'",
    )
      .bind(target)
      .first();
    expect(row).toEqual({ actor: OPERATOR, event: "SettingsUpdated", outcome: "Succeeded" });
  });
});

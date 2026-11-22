import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LoginOperator, PeopleAdmin } from "../src/index";
import { createUser, OPERATOR, OTHER_OPERATOR, testEnv, uniqueEmail } from "./helpers";

const loginOperator = (): LoginOperator => new LoginOperator(createExecutionContext(), testEnv);

const ensureUser = async (email: string): Promise<string> => {
  const row = await testEnv.DB.prepare("SELECT id FROM user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? (await createUser(email)).id;
};

const ensureOperator = async (): Promise<void> => {
  await ensureUser(OPERATOR);
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

  it("names a person by login id to an operator but hides another operator", async () => {
    const person = await createUser(uniqueEmail("named"));
    const operatorId = await ensureUser(OPERATOR);
    const otherOperatorId = await ensureUser(OTHER_OPERATOR);
    const login = loginOperator();

    expect(await login.personEmail(OPERATOR, person.id)).toEqual({ ok: true, email: person.email });
    expect(await login.personEmail(OPERATOR, operatorId)).toEqual({ ok: true, email: OPERATOR });
    expect(await login.personEmail(OPERATOR, otherOperatorId)).toEqual({
      ok: false,
      refusal: "not_found",
    });
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

  it("lets an operator named by email disable a person", async () => {
    const target = await createUser(uniqueEmail("disabled"));
    await ensureOperator();

    const changed = await new PeopleAdmin(createExecutionContext(), testEnv).updatePerson({
      callerId: OPERATOR,
      clientIp: "203.0.113.8",
      targetId: target.id,
      operatorGrant: true,
      stepUpToken: null,
      status: "Disabled",
    });

    expect(changed).toMatchObject({ ok: true, value: { userId: target.id, status: "Disabled" } });
    const row = await testEnv.DB.prepare(
      "SELECT actor, event, outcome FROM audit_event WHERE email = ? AND client_id = 'api'",
    )
      .bind(target.email)
      .first();
    expect(row).toEqual({ actor: OPERATOR, event: "Disabled", outcome: "Succeeded" });
  });
});

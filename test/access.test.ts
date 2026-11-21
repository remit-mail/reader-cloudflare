import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOperator, type Tenant } from "../src/access";

const tenant = (email: string, service = false): Tenant => ({
  tenantId: email,
  accountConfigId: "account-config",
  email,
  service,
});

describe("operator access", () => {
  const env = { OPERATOR_EMAILS: "operator@remit.test, second@remit.test" };

  it("admits an operator email and refuses another email", () => {
    assert.equal(isOperator(tenant("Operator@remit.test"), env), true);
    assert.equal(isOperator(tenant("reader@remit.test"), env), false);
  });

  it("never admits a service token", () => {
    assert.equal(isOperator(tenant("operator@remit.test", true), env), false);
  });
});

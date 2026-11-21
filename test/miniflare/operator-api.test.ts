import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const OPERATOR_SUBJECT = "access-subject-of-the-operator";

const db = (env as unknown as { DB: D1Database }).DB;

describe("operator classifier default", () => {
  it("makes a PUT visible to a second tenant", async () => {
    const saved = await SELF.fetch("http://example.test/api/system/classification-default", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-operator": "operator@remit.test",
        "x-subject": OPERATOR_SUBJECT,
        "x-tenant": "one",
      },
      body: JSON.stringify({
        presetId: "Mistral",
        model: "",
        baseUrl: "",
        apiKey: "test-classifier-key",
        enabled: true,
        dailyLimit: 200,
      }),
    });
    expect(saved.status).toBe(200);

    const resolved = await SELF.fetch("http://example.test/api/system/classification-default", {
      headers: { "x-tenant": "two" },
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ presetId: "Mistral", source: "Operator" });
  });
});

describe("person settings", () => {
  it("answers for a listed person by their login id", async () => {
    const tenantId = "access-subject-of-a-person";
    await db.batch([
      db
        .prepare("INSERT OR REPLACE INTO tenant_email (tenant_id, email) VALUES (?, ?)")
        .bind(tenantId, "person@remit.test"),
      db
        .prepare(
          "INSERT OR REPLACE INTO tenant_key (tenant_id, key_version, wrapped_key, iv) VALUES (?, 1, x'00', x'00')",
        )
        .bind(tenantId),
    ]);

    const read = await SELF.fetch("http://example.test/api/people/login-id-of-a-person/settings", {
      headers: { "x-operator": "operator@remit.test", "x-subject": OPERATOR_SUBJECT },
    });
    expect(read.status).toBe(200);

    const unknown = await SELF.fetch("http://example.test/api/people/someone-else/settings", {
      headers: { "x-operator": "operator@remit.test", "x-subject": OPERATOR_SUBJECT },
    });
    expect(unknown.status).toBe(404);
  });
});

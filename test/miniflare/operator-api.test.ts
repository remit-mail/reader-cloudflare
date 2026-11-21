import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const OPERATOR_SUBJECT = "access-subject-of-the-operator";

describe("operator classifier default", () => {
  it("makes a PUT visible to a second tenant", async () => {
    await (env as unknown as { DB: D1Database }).DB.prepare(
      "INSERT OR REPLACE INTO tenant_email (tenant_id, email) VALUES (?, ?)",
    )
      .bind(OPERATOR_SUBJECT, "operator@remit.test")
      .run();

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

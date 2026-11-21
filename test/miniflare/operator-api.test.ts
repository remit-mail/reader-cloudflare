import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("operator classifier default", () => {
  it("makes a PUT visible to a second tenant", async () => {
    const saved = await SELF.fetch("http://example.test/api/system/classification-default", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-operator": "operator@remit.test",
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

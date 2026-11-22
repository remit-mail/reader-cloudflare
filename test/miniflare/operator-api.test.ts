import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { deriveAccountConfigId } from "@remit/data-ports/id";
import { describe, expect, it } from "vitest";

const OPERATOR_SUBJECT = "access-subject-of-the-operator";

const db = (env as unknown as { DB: D1Database }).DB;

const OPERATOR_HEADERS = { "x-operator": "operator@remit.test", "x-subject": OPERATOR_SUBJECT };

const seedTenant = (tenantId: string, email: string): Promise<D1Result[]> =>
  db.batch([
    db
      .prepare("INSERT OR REPLACE INTO tenant_email (tenant_id, email) VALUES (?, ?)")
      .bind(tenantId, email),
    db
      .prepare(
        "INSERT OR REPLACE INTO tenant_key (tenant_id, key_version, wrapped_key, iv) VALUES (?, 1, x'00', x'00')",
      )
      .bind(tenantId),
  ]);

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
      headers: { "x-tenant": "two", "X-Remit-Partition": "client-forged-partition" },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get("X-Remit-Partition")).toBe(
      deriveAccountConfigId("operator@remit.test"),
    );
    expect(await resolved.json()).toMatchObject({ presetId: "Mistral", source: "Operator" });
  });
});

describe("person settings", () => {
  it("answers for a listed person by their login id", async () => {
    const tenantId = "access-subject-of-a-person";
    await seedTenant(tenantId, "person@remit.test");

    const read = await SELF.fetch("http://example.test/api/people/login-id-of-a-person/settings", {
      headers: OPERATOR_HEADERS,
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("x-account-config-read")).toBe(deriveAccountConfigId(tenantId));
    expect(read.headers.get("X-Remit-Partition")).toBe(deriveAccountConfigId(tenantId));

    const unknown = await SELF.fetch("http://example.test/api/people/someone-else/settings", {
      headers: OPERATOR_HEADERS,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.has("X-Remit-Partition")).toBe(false);
  });

  it("hides another operator's settings", async () => {
    await seedTenant("access-subject-of-another-operator", "other-operator@remit.test");
    const settings = "http://example.test/api/people/login-id-of-another-operator/settings";

    const read = await SELF.fetch(settings, { headers: OPERATOR_HEADERS });
    const patched = await SELF.fetch(settings, {
      method: "PATCH",
      headers: { ...OPERATOR_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const cleared = await SELF.fetch(`${settings}/classification-provider`, {
      method: "DELETE",
      headers: OPERATOR_HEADERS,
    });

    expect([read.status, patched.status, cleared.status]).toEqual([404, 404, 404]);
  });
});

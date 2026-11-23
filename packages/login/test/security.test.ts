import { describe, expect, it } from "vitest";
import { call, createUser, PASSWORD, signIn, testEnv, uniqueEmail } from "./helpers";

describe("Security with a signed-in session", () => {
  it("allows passkey registration and authenticator management after a day", async () => {
    const user = await createUser(uniqueEmail("security"), { totp: true, password: PASSWORD });
    const { cookie, sessionId } = await signIn(user.id);
    await testEnv.DB.prepare("UPDATE session SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 2 * 24 * 60 * 60_000, sessionId)
      .run();
    expect((await call("/api/auth/passkey/generate-register-options", { cookie })).status).toBe(
      200,
    );
    const first = await call("/app/security/backup-codes", { cookie, body: {} });
    expect(first.status).toBe(200);
    const { backupCodes } = (await first.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    const stored = await testEnv.DB.prepare("SELECT backup_codes FROM two_factor WHERE user_id = ?")
      .bind(user.id)
      .first<{ backup_codes: string }>();
    expect(stored?.backup_codes).not.toContain(backupCodes[0]);
    const second = await call("/app/security/backup-codes", { cookie, body: {} });
    expect(second.status).toBe(200);
    expect((await second.json()) as { backupCodes: string[] }).not.toEqual({ backupCodes });
    expect((await call("/app/security/disable-app", { cookie, body: {} })).status).toBe(200);
    expect(
      await testEnv.DB.prepare("SELECT 1 FROM two_factor WHERE user_id = ?").bind(user.id).first(),
    ).toBeNull();
    expect((await call("/app/second-step/app", { cookie, body: {} })).status).toBe(200);
  });

  it.each(["/app/second-step/app", "/app/security/disable-app", "/app/security/backup-codes"])(
    "%s requires a session and the login origin",
    async (path) => {
      expect((await call(path, { body: {} })).status).toBe(401);
      const user = await createUser(uniqueEmail("security-origin"), { totp: true });
      const { cookie } = await signIn(user.id);
      expect(
        (await call(path, { cookie, body: {}, headers: { origin: "https://attacker.test" } }))
          .status,
      ).toBe(403);
      expect(
        await testEnv.DB.prepare("SELECT 1 FROM two_factor WHERE user_id = ?")
          .bind(user.id)
          .first(),
      ).not.toBeNull();
    },
  );

  it("refuses passkey registration without a session", async () => {
    const response = await call("/api/auth/passkey/generate-register-options");
    expect(response.status).toBe(400);
  });
});

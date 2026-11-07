import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";

const FLASH_KEY = "login-admin-flash";

interface Flash {
  readonly tone: "ok" | "danger";
  readonly message: string;
}

const banner = (): HTMLElement | null => document.getElementById("banner");

const showFlash = (flash: Flash): void => {
  const element = banner();
  if (!element) return;
  element.hidden = false;
  element.className = `banner ${flash.tone}`;
  element.replaceChildren();
  const text = document.createElement("p");
  text.textContent = flash.message;
  element.append(text);
  if (flash.tone === "danger") {
    const link = document.createElement("a");
    const issues = element.dataset.issues ?? "";
    link.href = `${issues}?${new URLSearchParams({ title: "remit admin action failed", body: flash.message }).toString()}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Report an issue";
    element.append(link);
  }
};

const remember = (flash: Flash): void => {
  try {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify(flash));
  } catch {
    showFlash(flash);
  }
};

const recall = (): void => {
  try {
    const stored = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
    if (stored) showFlash(JSON.parse(stored) as Flash);
  } catch {
    return;
  }
};

const postJson = async (
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
};

const messageOf = (body: Record<string, unknown>, status: number): string =>
  typeof body.message === "string" ? body.message : `The login site answered ${status}.`;

const proofFor = async (
  opened: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  if (opened.method === "Passkey") {
    const assertion = await startAuthentication({
      optionsJSON: opened.options as PublicKeyCredentialRequestOptionsJSON,
    });
    return { assertion };
  }
  const code = window.prompt("Enter the code from your authenticator app");
  return code ? { totpCode: code.trim() } : null;
};

const runAction = async (form: HTMLFormElement): Promise<void> => {
  const action = form.dataset.action ?? "";
  const input = form.querySelector<HTMLInputElement>("input[name=targetEmail]");
  const targetEmail = input ? input.value : (form.dataset.target ?? "");
  const opened = await postJson("/app/admin/challenge", { action, targetEmail });
  if (opened.status !== 200) {
    showFlash({ tone: "danger", message: messageOf(opened.body, opened.status) });
    return;
  }
  const proof = await proofFor(opened.body).catch((error: unknown) => {
    showFlash({
      tone: "danger",
      message: `The confirmation prompt did not finish: ${error instanceof Error ? error.message : String(error)}.`,
    });
    return null;
  });
  if (proof === null) return;
  const done = await postJson("/app/admin/action", {
    adminChallengeId: opened.body.adminChallengeId,
    action,
    targetEmail,
    ...proof,
  });
  remember({
    tone: done.status === 200 ? "ok" : "danger",
    message: messageOf(done.body, done.status),
  });
  window.location.reload();
};

document.addEventListener("DOMContentLoaded", () => {
  recall();
  for (const form of document.querySelectorAll<HTMLFormElement>("form.admin-action")) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      runAction(form).catch((error: unknown) => {
        showFlash({
          tone: "danger",
          message: `The action did not finish: ${error instanceof Error ? error.message : String(error)}.`,
        });
      });
    });
  }
});

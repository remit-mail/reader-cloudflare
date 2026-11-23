import { SignedOutOverlay } from "@reader-recovery";
import { reportSignedOut, resetSignedOut } from "@reader-signed-out";
import { AuthProviderProvider } from "@remit/web-client/auth/provider";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { accessAuthProvider } from "../../packages/web/src/access-auth";

it("the shared Sign in control renews Access once per tab without signing out", async () => {
  const replace = vi.fn();
  const signOut = vi.fn();
  const browserWindow = window;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    new Proxy(browserWindow, {
      get(target, key) {
        return key === "location"
          ? { href: browserWindow.location.href, replace }
          : Reflect.get(target, key, target);
      },
    }),
  );
  sessionStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const provider = {
    ...accessAuthProvider,
    Account: ({ children }) => children({ email: "reader@remit.test", signOut }),
  } satisfies typeof accessAuthProvider;

  try {
    reportSignedOut();
    await act(async () => {
      root.render(
        createElement(AuthProviderProvider, { value: provider }, createElement(SignedOutOverlay)),
      );
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const button = container.querySelector("button");
      expect(button?.textContent).toContain("Sign in");
      await act(async () => button?.click());
      if (attempt === 0) await act(async () => reportSignedOut());
    }
    expect(replace).toHaveBeenCalledExactlyOnceWith("/mail/inbox?thread=kept&reauth=1#message");
    expect(signOut).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    resetSignedOut();
    container.remove();
    vi.unstubAllGlobals();
  }
});

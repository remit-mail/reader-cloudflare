export const ACCESS_EXPIRED = "remit:access-expired";

const RENEWAL_KEY = "remit-access-renewal-at";
const RENEWAL_GUARD_MS = 60_000;

export const renewalUrl = (): string => {
  const url = new URL(window.location.href);
  url.searchParams.set("reauth", "1");
  return `${url.pathname}${url.search}${url.hash}`;
};

export const renewOnce = (): boolean => {
  try {
    const elapsed = Date.now() - Number(window.sessionStorage.getItem(RENEWAL_KEY) ?? "0");
    if (elapsed >= 0 && elapsed < RENEWAL_GUARD_MS) return false;
    window.sessionStorage.setItem(RENEWAL_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.replace(renewalUrl());
  return true;
};

export const accessExpired = (response: Response): boolean =>
  response.type === "opaqueredirect" || response.status === 401;

// Both the generated client and raw mail fetches use the browser transport.
// Handle Access here before the shared client's 401 UI can offer signOut().
export const accessFetch =
  (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const protectedRequest =
      url.origin === window.location.origin &&
      /^\/(?:api|content|exports|outbox-upload)(?:\/|$)/.test(url.pathname);
    const response = await fetch(input, protectedRequest ? { ...init, redirect: "manual" } : init);
    if (protectedRequest && accessExpired(response)) {
      window.dispatchEvent(new Event(ACCESS_EXPIRED));
      renewOnce();
    }
    return response;
  };

export const configureAccessSession = (): void => {
  window.fetch = accessFetch(window.fetch.bind(window));
};

import { type Refusal, SIGN_IN_LINK_EXPIRED } from "./refusal";

export type Answer =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | Refusal;

export const signInRequest = async (
  path: string,
  body: Record<string, unknown>,
  query: string | undefined,
  post: (path: string, body: Record<string, unknown>) => Promise<Answer>,
  abandonQuery: () => void,
): Promise<Answer> => {
  const expiresAt = Number(new URLSearchParams(query).get("exp"));
  const needsFreshFlow =
    Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= Date.now() + 30_000;
  if (needsFreshFlow) {
    // Authenticate independently before an OAuth query can expire or consume an app code.
    // The caller then returns to the reader origin, where Access starts fresh state.
    // No client, redirect target, nonce or state from the abandoned query is reused.
    abandonQuery();
    return post(path, body);
  }
  const answer = await post(path, query === undefined ? body : { ...body, oauth_query: query });
  // A suspended request can outlive the margin above. Only the password endpoint is safe
  // to retry: its signature refusal precedes password verification, unlike an app code.
  if (
    !answer.ok &&
    answer.code === SIGN_IN_LINK_EXPIRED &&
    path === "/api/auth/sign-in/email" &&
    expiresAt > 0 &&
    expiresAt * 1000 <= Date.now()
  ) {
    abandonQuery();
    return post(path, body);
  }
  return answer;
};

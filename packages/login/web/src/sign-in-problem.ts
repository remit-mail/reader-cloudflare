import { type Failure, failureOf, type Refusal } from "./refusal";

export type SignInProblem =
  | Failure
  | { readonly kind: "wrong" }
  | { readonly kind: "disabled" }
  | { readonly kind: "passkey-cancelled" }
  | { readonly kind: "passkey-refused"; readonly message: string };

export interface SignInNotice {
  readonly tone: "danger" | "warning";
  readonly title: string;
  readonly body: string;
  readonly report?: string;
  readonly action?: "reset";
}

export const passwordProblem = (answer: Refusal): SignInProblem => {
  if (answer.status === 401) return { kind: "wrong" };
  if (answer.code === "BANNED_USER") return { kind: "disabled" };
  return failureOf(answer);
};

export const signInNotice = (problem: SignInProblem): SignInNotice | null => {
  switch (problem.kind) {
    case "wrong":
      return {
        tone: "danger",
        title: "Wrong email or password",
        body: "Check both and try again. Forgot it?",
        action: "reset",
      };
    case "locked":
      return {
        tone: "warning",
        title: "Sign-in is paused",
        body: `${problem.message} Forgot your password? Reset it with a link by email.`,
      };
    case "disabled":
      return {
        tone: "danger",
        title: "This account is disabled",
        body: "Ask the person who invited you.",
      };
    case "server":
      return {
        tone: "danger",
        title: "Sign-in failed on our side",
        body: `${problem.message} This is not your fault. Try again in a minute. If it keeps failing, report it.`,
        report: problem.message,
      };
    case "refused":
      return {
        tone: "danger",
        title: "The login site refused the sign-in",
        body: `${problem.message} Try again. If it keeps failing, report it.`,
        report: problem.message,
      };
    default:
      return null;
  }
};

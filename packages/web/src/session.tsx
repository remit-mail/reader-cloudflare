import { createContext, useCallback, useContext } from "react";
import type { ApiResult } from "./api";

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export const SignOutContext = createContext<((reason: string) => void) | null>(null);

export const useCall = (): (<T>(pending: Promise<ApiResult<T>>) => Promise<Outcome<T>>) => {
  const signOut = useContext(SignOutContext);
  if (signOut === null) throw new Error("useCall needs a SignOutContext provider");
  return useCallback(
    async <T,>(pending: Promise<ApiResult<T>>): Promise<Outcome<T>> => {
      const result = await pending;
      if (result.kind === "ok") return { ok: true, value: result.value };
      if (result.kind === "signed-out") {
        signOut(result.reason);
        return { ok: false, reason: `Your session ended: ${result.reason}` };
      }
      return { ok: false, reason: result.reason };
    },
    [signOut],
  );
};

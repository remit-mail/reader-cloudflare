import { useCallback, useEffect, useRef, useState } from "react";
import type { Outcome } from "./session";

export type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ready"; readonly value: T };

const LOADING = { kind: "loading" } as const;

export const useLoad = <T>(
  load: () => Promise<Outcome<T>>,
  key: string | null,
): readonly [Load<T>, () => void] => {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly nonce: number;
    readonly load: Load<T>;
  }>({
    key,
    nonce: 0,
    load: LOADING,
  });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    loadRef.current().then((result) => {
      if (!live) return;
      setState({
        key,
        nonce,
        load: result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "failed", reason: result.reason },
      });
    });
    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return [state.key === key ? state.load : LOADING, reload] as const;
};

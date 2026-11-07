import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { type Answer, get, post, withOAuth } from "./api";

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

type Refused = Extract<Answer, { ok: false }>;

const failed = (error: unknown): Refused => ({
  ok: false,
  status: 0,
  message: `The passkey prompt did not finish: ${error instanceof Error ? error.message : String(error)}.`,
  code: "PASSKEY_PROMPT",
});

export const assertPasskey = async (): Promise<
  { ok: true; assertion: unknown } | { ok: false; answer: Refused }
> => {
  const options = await get("/api/auth/passkey/generate-authenticate-options");
  if (!options.ok) return { ok: false, answer: options };
  return startAuthentication({
    optionsJSON: options.body as unknown as PublicKeyCredentialRequestOptionsJSON,
  }).then(
    (assertion) => ({ ok: true as const, assertion }),
    (error: unknown) => ({ ok: false as const, answer: failed(error) }),
  );
};

export const signInWithPasskey = async (): Promise<Answer> => {
  const asserted = await assertPasskey();
  if (!asserted.ok) return asserted.answer;
  return post(
    "/api/auth/passkey/verify-authentication",
    withOAuth({ response: asserted.assertion }),
  );
};

export const addPasskey = async (): Promise<Answer> => {
  const options = await get("/api/auth/passkey/generate-register-options");
  if (!options.ok) return options;
  const response = await startRegistration({
    optionsJSON: options.body as unknown as PublicKeyCredentialCreationOptionsJSON,
  }).catch((error: unknown) => failed(error));
  if ("ok" in response) return response;
  return post("/api/auth/passkey/verify-registration", { response });
};

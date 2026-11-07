import type { FormEvent } from "react";

export const noop = (): void => undefined;

export const hold = (event: FormEvent<HTMLFormElement>): void => {
  event.preventDefault();
};

export const CODES: readonly string[] = [
  "4k7p-2mxa",
  "9qrt-hh3c",
  "b2wz-7ngd",
  "u8ce-fk4v",
  "m3ya-0pls",
  "x6jd-qe9r",
  "t5hb-wv2n",
  "c1gu-zr8k",
  "p7fm-sy4e",
  "e0vn-ka6t",
];

export const TOTP_URI =
  "otpauth://totp/remit:invitee@example.com?secret=JBSWY3DPEHPK3PXP&issuer=remit";

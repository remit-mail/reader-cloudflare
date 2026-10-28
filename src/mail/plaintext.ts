import { env } from "cloudflare:workers";

const configuredHosts = (): readonly string[] =>
  (env.PLAINTEXT_MAIL_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");

export const allowsPlaintext = (host: string, secure: boolean): boolean =>
  !secure && configuredHosts().includes(host);

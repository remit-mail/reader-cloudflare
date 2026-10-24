import { env } from "cloudflare:workers";

const configuredHosts = (): readonly string[] => {
  const hosts: unknown = Reflect.get(env, "PLAINTEXT_MAIL_HOSTS");
  if (typeof hosts !== "string") return [];
  return hosts
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
};

export const allowsPlaintext = (host: string, secure: boolean): boolean =>
  !secure && configuredHosts().includes(host);

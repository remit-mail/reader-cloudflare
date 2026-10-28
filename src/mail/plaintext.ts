import { env } from "cloudflare:workers";

const configuredHosts = (): readonly string[] =>
  (env.PLAINTEXT_MAIL_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");

export const allowsPlaintext = (host: string, secure: boolean): boolean =>
  !secure && configuredHosts().includes(host);

export interface MailEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}

const aliases = (): ReadonlyMap<string, MailEndpoint> =>
  new Map(
    (env.MAIL_HOST_ALIASES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [from = "", to = ""] = entry.split("=");
        const at = to.lastIndexOf(":");
        const host = to.slice(0, at);
        return [
          from,
          { host, port: Number(to.slice(at + 1)), tls: !configuredHosts().includes(host) },
        ];
      }),
  );

export const mailEndpoint = (endpoint: MailEndpoint): MailEndpoint =>
  aliases().get(endpoint.host) ?? endpoint;

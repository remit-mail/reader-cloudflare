import {
  imapflowImplicit,
  imapflowStarttls,
  imapflowStarttlsSockets,
  nodemailerImplicit,
  nodemailerImplicitSocket,
  nodemailerStarttls,
  nodemailerStarttlsSocket,
} from "./libraries";
import { rawImplicitImap, rawImplicitSmtp, rawStarttlsImap, rawStarttlsSmtp } from "./raw";

const probes: Record<string, () => Promise<void>> = {
  "imapflow-tls": imapflowImplicit,
  "imapflow-starttls": imapflowStarttls,
  "imapflow-starttls-sockets": imapflowStarttlsSockets,
  "nodemailer-tls": nodemailerImplicit,
  "nodemailer-tls-socket": nodemailerImplicitSocket,
  "nodemailer-starttls": nodemailerStarttls,
  "nodemailer-starttls-socket": nodemailerStarttlsSocket,
  "raw-tls-imap": rawImplicitImap,
  "raw-tls-smtp": rawImplicitSmtp,
  "raw-starttls-imap": rawStarttlsImap,
  "raw-starttls-smtp": rawStarttlsSmtp,
};

const timeoutMs = 20_000;

const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error ? ` [${String(error.code)}]` : "";
  return `${error.name}: ${error.message}${code}`;
};

const run = async (probe: () => Promise<void>): Promise<Response> => {
  const started = Date.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  const error = await Promise.race([probe(), timeout]).then(
    () => null,
    (failure: unknown) => describe(failure),
  );
  return Response.json({ ok: error === null, error, durationMs: Date.now() - started });
};

export const spike = (path: string): Promise<Response> | Response | undefined => {
  if (path === "/spike") return Response.json(Object.keys(probes));
  const name = path.match(/^\/spike\/([\w-]+)$/)?.[1];
  if (name === undefined) return undefined;
  const probe = probes[name];
  if (probe === undefined) return new Response("unknown probe\n", { status: 404 });
  return run(probe);
};

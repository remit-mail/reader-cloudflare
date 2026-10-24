import { connect } from "cloudflare:sockets";

type Conversation = {
  read: (until: RegExp) => Promise<string>;
  write: (line: string) => Promise<void>;
  release: () => void;
};

const converse = (socket: Socket): Conversation => {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const read = async (until: RegExp): Promise<string> => {
    while (!until.test(buffer)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`socket closed before ${until}, got: ${buffer}`);
      buffer += decoder.decode(value, { stream: true });
    }
    const received = buffer;
    buffer = "";
    return received;
  };

  const write = (line: string): Promise<void> => writer.write(encoder.encode(`${line}\r\n`));

  const release = (): void => {
    reader.releaseLock();
    writer.releaseLock();
  };

  return { read, write, release };
};

export const rawImplicitImap = async (): Promise<void> => {
  const socket = connect(
    { hostname: "imap.gmail.com", port: 993 },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const io = converse(socket);
  await io.read(/^\* OK.*\r\n/m);
  await socket.close();
};

export const rawImplicitSmtp = async (): Promise<void> => {
  const socket = connect(
    { hostname: "smtp.gmail.com", port: 465 },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const io = converse(socket);
  await io.read(/^220 .*\r\n/m);
  await io.write("EHLO spike.invalid");
  await io.read(/^250 .*\r\n/m);
  await socket.close();
};

export const rawStarttlsImap = async (): Promise<void> => {
  const plain = connect(
    { hostname: "imap.gmx.com", port: 143 },
    { secureTransport: "starttls", allowHalfOpen: false },
  );
  const io = converse(plain);
  await io.read(/^\* OK.*\r\n/m);
  await io.write("a STARTTLS");
  await io.read(/^a OK.*\r\n/m);
  io.release();
  const secure = plain.startTls();
  const tls = converse(secure);
  await tls.write("b CAPABILITY");
  await tls.read(/^b OK.*\r\n/m);
  await secure.close();
};

export const rawStarttlsSmtp = async (): Promise<void> => {
  const plain = connect(
    { hostname: "smtp.gmail.com", port: 587 },
    { secureTransport: "starttls", allowHalfOpen: false },
  );
  const io = converse(plain);
  await io.read(/^220 .*\r\n/m);
  await io.write("EHLO spike.invalid");
  await io.read(/^250 .*\r\n/m);
  await io.write("STARTTLS");
  await io.read(/^220 .*\r\n/m);
  io.release();
  const secure = plain.startTls();
  const tls = converse(secure);
  await tls.write("EHLO spike.invalid");
  await tls.read(/^250 .*\r\n/m);
  await secure.close();
};

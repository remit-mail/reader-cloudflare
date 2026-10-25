declare module "node:net" {
  const net: { connect(options: { host: string; port: number }): unknown };
  export default net;
}

declare module "node:tls" {
  const tls: { connect(options: { host: string; port: number; servername: string }): unknown };
  export default tls;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: Uint8Array | ArrayBuffer | string, encoding?: "utf8"): Buffer;
    static concat(list: readonly Uint8Array[]): Buffer;
    toString(encoding?: "utf8"): string;
  }
}

declare module "node:stream" {
  export class Readable implements AsyncIterable<Uint8Array> {
    static from(chunks: Iterable<Uint8Array>): Readable;
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
  }
}

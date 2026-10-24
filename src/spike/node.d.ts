declare module "node:net" {
  const net: { connect(options: { host: string; port: number }): unknown };
  export default net;
}

declare module "node:tls" {
  const tls: { connect(options: { host: string; port: number; servername: string }): unknown };
  export default tls;
}

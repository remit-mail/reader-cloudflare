// wrangler.jsonc aliases packages the Worker loads but never calls to these
// stubs, so they leave the bundle and cost no startup CPU. Any use throws.
export const unusedDependency = (name: string): unknown => {
  const fail = (): never => {
    throw new Error(
      `${name} is aliased out of the Worker bundle in wrangler.jsonc and must not be called`,
    );
  };
  return new Proxy(function unused() {}, { apply: fail, construct: fail, get: fail });
};

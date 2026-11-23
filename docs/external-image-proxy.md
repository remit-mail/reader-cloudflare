# External images (C2c)

`POST /api/image-proxy` runs behind the app's existing Access authentication and
tenant rate limit. It derives provenance from
the authenticated tenant, never from request headers or query parameters. It
performs no D1, R2 or Durable Object reads/writes. It makes only image
HTTP requests; it does not persist images on the server.

Send the complete absolute destination URL as the UTF-8 request body with
`Content-Type: text/plain;charset=UTF-8`. The request path is fixed and has no
query string: never put the destination in the path, query or headers. GET is
refused with 405; query parameters are never used to choose a destination.
Workers invocation logs record the incoming request URL, not its body, so this
contract keeps destination paths, tracking IDs and signed query credentials out
of platform logs without depending on query-string redaction settings.

The destination must be an absolute HTTP(S) URL on port 80 or 443, without
credentials. IP literals (including URL-normalized numeric forms), single-label
names, localhost and reserved local suffixes are refused. Redirects are refused.
The final connection uses Workers fetch's network isolation. This deployment
uses a Worker custom domain without an origin server, so global fetch reaches
only the public Internet. This connection-time boundary is a security dependency
of this implementation.

Only status 200 image MIME responses are returned; SVG is refused. Each attempt
has a 15-second deadline including headers and streaming bytes. The stream
is capped at 10 MiB regardless of Content-Length. An oversized declared length
returns 413; a stream exceeding the limit after headers have been sent is
terminated, so the client must finish reading the body before saving it.
Transient network/upstream failures retry at most ten attempts with delays
of 100, 200, 400, 800, 1600, 3200, 6400, 12800 and 25600 milliseconds. Validation
refusals, redirects and MIME/size failures do not retry; an interrupted response
body cannot retry once returned to the client.

Requests carry a fixed generic User-Agent and Accept header, with no caller
headers or credentials. Responses carry only a normalized image Content-Type,
private cache policy, nosniff, restrictive CSP and C2a's X-Remit-Partition.
Upstream cookies and other headers are discarded. Application logs contain only
the destination hostname and attempt number, never upstream error text or URLs.

## Existing package audit

Checked the installed reader packages, including `@remit/backend@10.0.0` and
`@remit/api-openapi-spec@0.0.119`, and the npm tarball for
`@remit/web-client@0.0.356`. There is no existing image proxy route, remote-image
URL rewrite hook or proxy runtime config field. Reader's OpenAPI paths have no
image/proxy operation. The web client's `MessageBody` passes `allowImages` and
`resolveCid` into `MessageBodyView`; only CID images currently fetch bytes through
the offline runtime. `RemitRuntimeConfig` has no external-image setting. C2a's
existing `withPartition` helper is reused here.

## Reader-ui prerequisite

Add an optional `externalImageProxyUrl?: string` to raw/normalized runtime config
and the preset's config contract. This host will set it to `/api/image-proxy`.
Reject a configured cross-origin proxy or one with a query string or fragment.
Resolve relative image references against their existing message base first:
`const resolvedRemoteUrl = new URL(remoteUrl, messageBase).href`.
For a permitted HTTP(S) remote image, fetch bytes with:

```ts
fetch("/api/image-proxy", {
  method: "POST",
  credentials: "same-origin",
  redirect: "manual",
  headers: { "Content-Type": "text/plain;charset=UTF-8" },
  body: resolvedRemoteUrl,
});
```

An `<img src>` cannot issue this request: finish fetching and validating the bytes,
then display a local blob URL. The POST is not a browser HTTP-cache lookup.

Apply the hook only after the existing explicit image permission allows display
(load once or sender trust); never fetch blocked images or background-prefetch
tracking images. Route every permitted remote image source through it, including
sanitized srcset/CSS image URLs supported by the renderer. CID, blob and data
images retain their existing handling.

Fetch the proxy bytes through the tenant/generation-bound offline runtime using
same-origin credentials and manual redirects. Admit only complete 200 responses
with expected image MIME and matching X-Remit-Partition; recreate blob URLs when
reopening. Within the existing authenticated partition/generation namespace, use
`JSON.stringify(["external-image", resolvedRemoteUrl])` as the stable storage key.
The complete resolved URL, including its query string, identifies bytes; never
apply the `/content/*` authorization-query stripping rule. Different destination
URLs must not collide just because they share the same POST endpoint. Store and
retrieve binary bytes explicitly through the offline runtime; do not use the POST
request itself as a Cache API key. Proxy responses are binary content, not JSON
API queries. Preserve existing cached bytes on an unsuccessful refresh and surface
save failures. This Worker change alone does not make remote
images available offline; reader-ui must add this wiring.

Runtime references: [Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
and [Workers network isolation](https://blog.cloudflare.com/workers-environment-live-object-bindings/).

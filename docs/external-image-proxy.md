# External images (C2c)

`GET /api/image-proxy?url=<encodeURIComponent(remoteUrl)>` runs behind the app's
existing Access authentication and tenant rate limit. It derives provenance from
the authenticated tenant, never from request headers or query parameters. It
performs no D1, R2 or Durable Object reads/writes. It makes only DNS and image
HTTP requests; it does not persist images on the server.

The destination must be an absolute HTTP(S) URL on port 80 or 443, without
credentials. IP literals (including URL-normalized numeric forms), single-label
names, localhost and reserved local suffixes are refused. Both A and AAAA DNS
answers must contain only public unicast addresses; mapped/transition IPv6,
private, CGNAT, loopback, link-local, multicast, documentation and other reserved
ranges are refused. IPv6 must also match an allocated global prefix from the
[IANA registry](https://www.iana.org/assignments/ipv6-unicast-address-assignments/);
the allowlist must be updated when new prefixes are allocated. DNS is checked
anew on every attempt. Redirects are refused.
The resolver is Cloudflare's fixed DNS-over-HTTPS endpoint. The final connection
uses Workers fetch's network isolation; there is no arbitrary-host IP-pinning
API in fetch. `cf.resolveOverride` is restricted to hosts in the same zone and
cannot pin these external destinations. Thus DNS preflight and the connection
are separate resolutions, with the runtime's private-network protection as the
connection-time boundary. This is a security dependency of this implementation.

Only status 200 image MIME responses are returned; SVG is refused. Each attempt
has a 15-second deadline including DNS, headers and streaming bytes. The stream
is capped at 10 MiB regardless of Content-Length. An oversized declared length
returns 413; a stream exceeding the limit after headers have been sent is
terminated, so the client must finish reading the body before saving it.
Transient DNS/network/upstream failures retry at most ten attempts with delays
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
For a permitted HTTP(S) remote image, build a same-origin URL with
`new URL(externalImageProxyUrl, location.origin)`, then
`proxy.searchParams.set("url", remoteUrl)`. Reject a configured cross-origin proxy.
Resolve relative image references against their existing message base first.

Apply the hook only after the existing explicit image permission allows display
(load once or sender trust); never fetch blocked images or background-prefetch
tracking images. Route every permitted remote image source through it, including
sanitized srcset/CSS image URLs supported by the renderer. CID, blob and data
images retain their existing handling.

Fetch the proxy bytes through the tenant/generation-bound offline runtime using
same-origin credentials and manual redirects. Admit only complete 200 responses
with expected image MIME and matching X-Remit-Partition; recreate blob URLs when
reopening. Keep the _complete destination URL_ in the storage key, including its
query string: this proxy's `url` parameter identifies bytes and must not undergo
the `/content/*` authorization-query stripping rule. Proxy responses are binary
content, not JSON API queries. Preserve existing cached bytes on an unsuccessful
refresh and surface save failures. This Worker change alone does not make remote
images available offline; reader-ui must add this wiring.

Runtime references: [Workers Request resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/)
and [Workers network isolation](https://blog.cloudflare.com/workers-environment-live-object-bindings/).

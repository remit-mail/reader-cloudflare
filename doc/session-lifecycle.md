# Live browser session investigation

Investigated from `54deed0` with `@remit/web-client@0.0.355` and login
`better-auth@1.7.18`. This reproduces a code path that ends a live login; it does
not establish which path each historical incident took without a browser trace.

## Reproduced cause

1. The page remains open beyond the 15-minute Access application/global session
   (`infra/main.tf:173`, `infra/login.tf:109`). Background API activity does not
   perform a top-level OIDC authorization navigation.
2. Access redirects a protected fetch to authentication. The pinned web client's
   `dist/src/lib/network-error.js:61` deliberately uses manual redirects to avoid
   a cross-origin login redirect failing CORS. It maps `opaqueredirect` to 401.
3. `dist/src/lib/escalate.js:10` reports that 401 as signed out. The Access shell
   only probes on mount, visibility changes and every five minutes (baseline
   `packages/web/src/access-auth.tsx:100`), leaving the shared overlay reachable
   before the next probe starts renewal.
4. The shared `dist/src/components/ui/SignedOutOverlay.js:27` calls the provider's
   **signOut** when the user clicks **Sign in**. The Cloudflare provider supplies
   `/sign-out` on the login host (baseline `packages/web/src/access-auth.tsx:154`).
   `AccessAccount` always renders its children, even with no identity, rather
   than its fallback. This also explains why the recovery button takes the logout
   branch.
5. `packages/login/src/index.ts:126` calls `appSignOut`;
   `packages/login/src/routes/app.ts:397` deletes the session's OAuth access tokens
   and the still-live login session, clears its cookie, and redirects through
   Access logout. Now an expired 15-minute Access credential has become an actual
   end of the 90-day login. A settings **Sign in again** control in the same
   package also uses the provider's signOut callback.

The shared UI package lives in `remit-mail/reader-ui`, rather than `reader`.
The fix belongs in this composition root: it must renew Access before a generic
401 recovery surface receives control. No package change or dependency bump is
needed.

## Lifecycle checks

- **Login session:** `packages/login/src/auth.ts:278` sets 90 days and one-day
  `updateAge`. Cookie caching is not enabled. Better Auth's signed, HttpOnly,
  SameSite=Lax opaque session cookie refers to the D1 session; it is not an OAuth
  refresh token. OIDC authorization calls `getSessionFromCtx`, which renews the
  session and cookie when due. `packages/login/test/token-race.test.ts` verifies both after
  aging a live session by two days, plus concurrent authorizations and exchanges
  using the same cookie. Ordinary authorization neither rotates that cookie's
  opaque token nor revokes the other device's login.
- **OIDC:** `packages/login/src/auth.ts:329` and
  `npm-scripts/oauth-client.mjs:13` allow only `authorization_code`.
  `infra/login.tf:69` requests `openid email profile`, without `offline_access`.
  The access and ID tokens last 900 seconds. The added test confirms no refresh
  token is issued. There is consequently no login refresh-token rotation, reuse
  detection or rotation revocation to repair or relax in this browser flow.
- **Access/browser:** A fresh top-level navigation can run Access's authorization
  redirect using the login cookie. An XHR/fetch redirect does not navigate the
  page; following it can instead fail CORS. Manual redirect detection avoids
  guessing that a network failure means sign-out. Top-level renewal also avoids
  depending on third-party iframe cookies. A genuinely missing login cookie,
  revoked session or explicit OIDC reauthentication requirement can still prompt
  for credentials; no live browser trace established those as incident causes.
  See [Cloudflare's AJAX session guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax).
- **PWA and builds:** `packages/web/vite.config.ts` enables the shared worker.
  Its shipped `src/lib/pwa-protocol.ts:13` excludes `reauth=1` from shell caching;
  `harness/pwa/sw.ts` does not cache API/auth responses. An ordinary reload can
  return the cached shell and need not reach Access; the marked renewal URL does.
  The old local `packages/web/src/stale-build.ts` has moved into the shared
  client. PWA build updates use its worker coordinator; neither update path
  deletes login sessions or OAuth tokens.
- **Offline contract:** #194 supplies authenticated, no-store `/api/session`
  (`src/index.ts:242`). The pinned web-client version has no offline runtime or
  host `verifySession` wiring. The newer reader-ui offline runtime requires a
  fresh host verification, deduplicates it within a tab, and treats a null result
  as unverified, not a login-session deletion. It is not executing in this build.
- **Concurrency and clocks:** Tabs share the opaque login cookie and can authorize
  concurrently; the service worker does not run a token refresh. Renewal is
  guarded per tab for a minute. A stored future timestamp previously suppressed
  automatic renewal until the device clock caught up; the guard now accepts only
  elapsed times within that minute. Worker JWT verification uses server time,
  verifies signature/issuer/audience and allows 60 seconds of skew
  (`src/access.ts:225`, `src/access.ts:242`); none of those checks changes.
- **MCP:** `src/mcp/auth.ts` constructs a separate authorization server over app D1
  `mcp_*` tables and `MCP_AUTH_SECRET`. Its refresh tokens belong to machine
  clients, not the Access/login browser flow. No MCP token change is needed for
  this reproduction. Rotation grace/reuse behavior was not changed.

## Fix and verification

`access-session.ts` installs the host's fetch boundary at provider configuration.
It covers same-origin API, mail-content, export and upload fetches, including
both the generated API client and raw fetches. Before returning a 401 or opaque
redirect to a caller it signals the Access shell and starts the existing marked
top-level renewal. The shell removes shared recovery controls, even when the
navigation guard requires the explicit renewal link. A late successful probe
cannot reopen the old document's signed-out shell. Other origins and OAuth
endpoints retain their transport behavior; denials, throttling, server errors
and network failures retain their original outcomes. No request is replayed.

`test/access-session.test.ts` reproduces expired redirect and direct-401
responses, with concurrent generated/raw requests and one renewal navigation.
The three expiry cases fail with the former pass-through transport and pass with
the fix. The tests also check request/body/CSRF-header preservation, non-auth
failures, origin scoping and a backwards clock correction. The login tests
exercise actual Better Auth/D1 authorization, cookie renewal and code exchange.

Access policies, Tofu configuration, token signature checks, CSRF and login
brute-force limits are unchanged. Validation does not include a live browser
round trip through Cloudflare Access; after review/deployment, keep desktop and
installed PWA sessions open across two 15-minute boundaries and confirm renewal
without a login `SignOut` audit event.

# reader-cloudflare

remit reader on Cloudflare Workers.
`AGENTS.md` holds the contributor rules and the scripts.

## Run it locally

You need Node 24.

```sh
npm ci
npm run dev   # the Worker on http://localhost:8790
npm run e2e   # reader's Dovecot and Mailpit, the Worker under wrangler dev, Playwright
```

`ACCESS_DEV_IDENTITY` (set only in the `e2e` wrangler environment) signs every loopback request in as that email, in place of a Cloudflare Access token.

To test a browser upgrade without mail containers, install Playwright Chromium
(`npx playwright install --with-deps chromium`), prepare a baseline checkout with
`npm ci`, then run `npm run e2e:upgrade -- <baseline checkout>`. For the Access
renewal regression, use `efa74ed` (the build immediately before #200). The runner
builds both checkouts and switches between their real Workers behind one origin,
keeping the old service worker and persisted queries. Access and mail responses
are fixtures; the test checks renewed accounts and an uncached message body.

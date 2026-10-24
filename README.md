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

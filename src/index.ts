import { log } from "./log";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    log.info("request", { method: request.method, path: url.pathname });
    return new Response("remit reader\n", { headers: { "content-type": "text/plain" } });
  },
} satisfies ExportedHandler;

import { log } from "./log";
import { spike } from "./spike";

export default {
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    log.info("request", { method: request.method, path: url.pathname });
    const spiked = spike(url.pathname);
    if (spiked !== undefined) return spiked;
    return new Response("remit reader\n", { headers: { "content-type": "text/plain" } });
  },
} satisfies ExportedHandler;

import { Hono } from "hono";
import { cache } from "hono/cache";
import { getConnInfo } from "hono/cloudflare-workers";
import { cors } from "hono/cors";
import { proxy } from "hono/proxy";
import { extractOgp } from "./ogp";
import { wantsJson } from "./utils";

type Env = {
  Bindings: {
    CORS_ORIGIN: string | undefined;
  };
};

const app = new Hono<Env>();

export const BREAKER_CACHE_NAME = "upstream-circuit-breaker";
export const BREAKER_TTL_SECONDS = 86_400;

const breakerKey = (hostname: string) => new Request(`https://${hostname}/`);

app.on(
  ["OPTIONS", "HEAD", "GET"],
  "/",
  cache({
    cacheName: "default",
    vary: "Accept, Origin",
    // Keep OGP JSON and proxied responses in separate cache entries so
    // they never collide, regardless of upstream Vary support.
    keyGenerator: (c) => {
      const u = new URL(c.req.url);
      if (c.req.method !== "GET") u.searchParams.set("__method", c.req.method);
      if (wantsJson(c.req.header("Accept"))) u.searchParams.set("__ogp-json", "1");
      return u.toString();
    },
  }),
  async (c, next) => {
    const middleware = cors({
      origin: c.env.CORS_ORIGIN?.split(",").map((x) => x.trim()) ?? "*",
      allowMethods: ["HEAD", "GET"],
    });
    return middleware(c, next);
  },
  async (c) => {
    const url = c.req.query("url");
    const parsed = url !== undefined && URL.canParse(url) ? new URL(url) : null;
    if (
      parsed === null ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin === new URL(c.req.url).origin
    ) {
      return c.notFound();
    }
    const breakerCache = await caches.open(BREAKER_CACHE_NAME);
    const markerKey = breakerKey(parsed.hostname);
    if ((await breakerCache.match(markerKey)) !== undefined) {
      return c.text("Bad Gateway", 502);
    }

    const json = wantsJson(c.req.header("Accept"));
    let upstream: Response;
    try {
      upstream = await proxy(parsed.href, {
        method: c.req.method,
        headers: {
          ...c.req.header(),
          // Request the HTML page so OGP meta tags can be parsed,
          // not a JSON API response from the origin.
          ...(json ? { Accept: "text/html" } : {}),
          "X-Forwarded-For": getConnInfo(c).remote.address,
          "X-Forwarded-Host": c.req.header("host"),
        },
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      console.error(
        `Opening upstream circuit breaker for hostname=${parsed.hostname} ttl=${BREAKER_TTL_SECONDS}s error=${errorType}`
      );
      await breakerCache.put(
        markerKey,
        new Response("1", {
          headers: { "Cache-Control": `max-age=${BREAKER_TTL_SECONDS}` },
        })
      );
      return c.text("Bad Gateway", 502);
    }

    if (json) {
      const cacheControl = upstream.headers.get("Cache-Control");
      if (cacheControl !== null) {
        c.header("Cache-Control", cacheControl);
      }
      return c.json(await extractOgp(upstream));
    }

    return upstream;
  }
);

export default app;

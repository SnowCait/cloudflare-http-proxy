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

const breakerKey = (origin: string) => new Request(origin);

const summarizeUpstreamError = (error: unknown): string => {
  if (!(error instanceof Error)) return "upstream_request_failure";

  const message = error.message.toLowerCase();
  if (message.includes("too many redirect")) return "too_many_redirects";
  if (
    message.includes("dns") ||
    message.includes("name resolution") ||
    message.includes("host not found") ||
    message.includes("enotfound")
  ) {
    return "dns_failure";
  }
  if (
    message.includes("connection") ||
    message.includes("econn") ||
    message.includes("socket")
  ) {
    return "connection_failure";
  }
  if (message.includes("network") || message.includes("timed out")) {
    return "network_failure";
  }
  return "upstream_request_failure";
};

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
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin === new URL(c.req.url).origin
    ) {
      return c.text("Bad Request", 400);
    }
    const breakerCache = await caches.open(BREAKER_CACHE_NAME);
    const markerKey = breakerKey(parsed.origin);
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
      console.error({
        event: "upstream_circuit_breaker_opened",
        upstreamOrigin: parsed.origin,
        ttlSeconds: BREAKER_TTL_SECONDS,
        errorType,
        errorSummary: summarizeUpstreamError(error),
      });
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

import { Hono } from "hono";
import { cache } from "hono/cache";
import { getConnInfo } from "hono/cloudflare-workers";
import { cors } from "hono/cors";
import { proxy } from "hono/proxy";
import { extractOgp } from "./ogp";
import { wantsJson } from "./utils";

type Env = {
  Bindings: {
    ALLOWED_ORIGINS: string | undefined;
  };
};

const app = new Hono<Env>();

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
    const allowed = c.env.ALLOWED_ORIGINS?.split(/[\n,]/)
      .map((x) => x.trim())
      .filter((x) => x !== "");

    if (allowed !== undefined && allowed.length > 0 && !allowed.includes("*")) {
      const origin = c.req.header("Origin");
      if (origin === undefined || !allowed.includes(origin)) {
        return c.text("Forbidden", 403);
      }
    }

    const middleware = cors({
      origin: allowed !== undefined && allowed.length > 0 ? allowed : "*",
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
    const json = wantsJson(c.req.header("Accept"));
    const response = proxy(parsed.href, {
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

    if (json) {
      const upstream = await response;
      const cacheControl = upstream.headers.get("Cache-Control");
      if (cacheControl !== null) {
        c.header("Cache-Control", cacheControl);
      }
      return c.json(await extractOgp(upstream));
    }

    return response;
  }
);

export default app;

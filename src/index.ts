import { Hono } from "hono";
import { cache } from "hono/cache";
import { getConnInfo } from "hono/cloudflare-workers";
import { cors } from "hono/cors";
import { proxy } from "hono/proxy";

type Env = {
  Bindings: {
    CORS_ORIGIN: string | undefined;
  };
};

const app = new Hono<Env>();

app.on(
  ["OPTIONS", "HEAD", "GET"],
  "/",
  cache({ cacheName: "default" }),
  async (c, next) => {
    const middleware = cors({
      origin: c.env.CORS_ORIGIN?.split(",").map((x) => x.trim()) ?? "*",
      allowMethods: ["HEAD", "GET"],
    });
    return middleware(c, next);
  },
  (c) => {
    const url = c.req.query("url");
    if (
      url === undefined ||
      !URL.canParse(url) ||
      new URL(url).origin === new URL(c.req.url).origin
    ) {
      return c.notFound();
    }
    console.log(c.req.header("Host"));
    return proxy(url, {
      method: c.req.method,
      headers: {
        ...c.req.header(),
        "X-Forwarded-For": getConnInfo(c).remote.address,
        "X-Forwarded-Host": c.req.header("host"),
      },
    });
  }
);

export default app;

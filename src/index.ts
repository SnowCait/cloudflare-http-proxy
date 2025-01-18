import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";

type Env = {
  Bindings: {
    CORS_ORIGIN: string;
  };
};

const app = new Hono<Env>();

app.on(
  ["OPTIONS", "HEAD", "GET"],
  "/",
  cache({ cacheName: "default" }),
  async (c, next) => {
    const middleware = cors({
      origin: c.env.CORS_ORIGIN ?? "*",
      allowMethods: ["HEAD", "GET"],
    });
    return middleware(c, next);
  },
  (c) => {
    const url = c.req.query("url");
    if (url === undefined) {
      return c.notFound();
    }
    return fetch(url, { method: c.req.method });
  }
);

export default app;

import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";

const app = new Hono();

app.on(
  ["OPTIONS", "HEAD", "GET"],
  "/",
  cache({ cacheName: "default" }),
  cors({ origin: "https://nostter.app", allowMethods: ["HEAD", "GET"] }),
  (c) => {
    const url = c.req.query("url");
    if (url === undefined) {
      return c.notFound();
    }
    return fetch(url, { method: c.req.method });
  }
);

export default app;

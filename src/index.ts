import { Hono } from "hono";
import { cache } from "hono/cache";

const app = new Hono();

app.on(["HEAD", "GET"], "/", cache({ cacheName: "default" }), (c) => {
  const url = c.req.query("url");
  if (url === undefined) {
    return c.notFound();
  }
  return fetch(url);
});

export default app;

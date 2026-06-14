import { SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "./index";

vi.mock("hono/proxy", () => ({
  proxy: vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response("<html><head><meta property='og:title' content='Mocked' /></head></html>", {
        headers: { "Content-Type": "text/html" },
      })
    )
  ),
}));

vi.mock("hono/cloudflare-workers", async (importOriginal) => {
  const original = await importOriginal<typeof import("hono/cloudflare-workers")>();
  return {
    ...original,
    getConnInfo: () => ({ remote: { address: "1.2.3.4" } }),
  };
});

describe("app route /", () => {
  it("returns 404 when url param is missing", async () => {
    const res = await SELF.fetch("https://proxy.example.com/");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an invalid URL", async () => {
    const res = await SELF.fetch("https://proxy.example.com/?url=not-a-url");
    expect(res.status).toBe(404);
  });

  it("returns 404 when url has the same origin as the worker", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://proxy.example.com/other"
    );
    expect(res.status).toBe(404);
  });

  it("returns OGP JSON when Accept is application/json", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.com/page",
      { headers: { Accept: "application/json" } }
    );
    expect(res.status).toBe(200);
    const json = await res.json<Record<string, string>>();
    expect(json["og:title"]).toBe("Mocked");
  });

  it("returns proxied response for normal Accept header", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.com/page",
      { headers: { Accept: "text/html" } }
    );
    expect(res.status).toBe(200);
  });

  it("returns CORS headers on OPTIONS request", async () => {
    const res = await SELF.fetch("https://proxy.example.com/", {
      method: "OPTIONS",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("returns 404 for data: URL", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=data:text/html,hello"
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for file: URL", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=file:///etc/passwd"
    );
    expect(res.status).toBe(404);
  });

  it("HEAD response does not pollute GET cache", async () => {
    const target = "https://proxy.example.com/?url=https://example.com/page";
    await SELF.fetch(target, { method: "HEAD" });
    const res = await SELF.fetch(target, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("ALLOWED_ORIGINS filtering", () => {
  const url = "https://proxy.example.com/?url=https://example.com/page";

  const request = async (init: RequestInit, env: { ALLOWED_ORIGINS?: string }) => {
    const ctx = createExecutionContext();
    const res = await app.request(url, init, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  it("allows a request whose Origin is in the list", async () => {
    const res = await request(
      { headers: { Origin: "https://allowed.example.com" } },
      { ALLOWED_ORIGINS: "https://allowed.example.com" }
    );
    expect(res.status).toBe(200);
  });

  it("rejects a request whose Origin is not in the list", async () => {
    const res = await request(
      { headers: { Origin: "https://evil.example.com" } },
      { ALLOWED_ORIGINS: "https://allowed.example.com" }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a request without an Origin header when configured", async () => {
    const res = await request(
      {},
      { ALLOWED_ORIGINS: "https://allowed.example.com" }
    );
    expect(res.status).toBe(403);
  });

  it("allows any Origin when ALLOWED_ORIGINS is unset", async () => {
    const res = await request(
      { headers: { Origin: "https://anything.example.com" } },
      { ALLOWED_ORIGINS: undefined }
    );
    expect(res.status).toBe(200);
  });
});

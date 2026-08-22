import { SELF } from "cloudflare:test";
import { proxy } from "hono/proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKER_CACHE_NAME, BREAKER_TTL_SECONDS } from "./index";

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
  beforeEach(() => {
    vi.mocked(proxy).mockClear();
  });

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

  it("opens an origin circuit breaker when the upstream proxy throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(proxy).mockRejectedValueOnce(
      new TypeError(
        "Too many redirects at https://user:secret@broken.example/private?token=secret"
      )
    );

    const first = await SELF.fetch(
      "https://proxy.example.com/?url=https://user:secret@broken.example/private?token=secret"
    );

    expect(first.status).toBe(502);
    expect(await first.text()).toBe("Bad Gateway");
    expect(first.headers.get("Retry-After")).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith({
      event: "upstream_circuit_breaker_opened",
      upstreamOrigin: "https://broken.example",
      ttlSeconds: BREAKER_TTL_SECONDS,
      errorType: "TypeError",
      errorSummary: "too_many_redirects",
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("user");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("private");

    const marker = await (await caches.open(BREAKER_CACHE_NAME)).match(
      "https://broken.example/"
    );
    expect(marker).toBeDefined();
    expect(marker?.headers.get("Cache-Control")).toBe(
      `max-age=${BREAKER_TTL_SECONDS}`
    );

    const second = await SELF.fetch(
      "https://proxy.example.com/?url=https://broken.example/second"
    );
    expect(second.status).toBe(502);
    expect(second.headers.get("Retry-After")).toBeNull();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const otherHost = await SELF.fetch(
      "https://proxy.example.com/?url=https://healthy-after-failure.example/page"
    );
    expect(otherHost.status).toBe(200);
    expect(proxy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("isolates breakers by origin while sharing them across paths and queries", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(proxy).mockRejectedValueOnce(new TypeError("Connection failed"));

    const failed = await SELF.fetch(
      "https://proxy.example.com/?url=https://ports.example:1234/first?value=1"
    );
    expect(failed.status).toBe(502);

    const sameOrigin = await SELF.fetch(
      "https://proxy.example.com/?url=https://ports.example:1234/other?value=2"
    );
    expect(sameOrigin.status).toBe(502);
    expect(proxy).toHaveBeenCalledTimes(1);

    const differentPort = await SELF.fetch(
      "https://proxy.example.com/?url=https://ports.example/healthy"
    );
    expect(differentPort.status).toBe(200);
    expect(proxy).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });

  it("does not open the circuit breaker for an upstream HTTP error response", async () => {
    vi.mocked(proxy).mockImplementationOnce(async () =>
      new Response("failure", { status: 503 })
    );

    const first = await SELF.fetch(
      "https://proxy.example.com/?url=https://http-error.example/first"
    );
    expect(first.status).toBe(503);

    const second = await SELF.fetch(
      "https://proxy.example.com/?url=https://http-error.example/second"
    );
    expect(second.status).toBe(200);
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(
      await (
        await caches.open(BREAKER_CACHE_NAME)
      ).match("https://http-error.example/")
    ).toBeUndefined();
  });
});

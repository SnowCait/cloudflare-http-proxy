import { SELF } from "cloudflare:test";
import { proxy } from "hono/proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKER_CACHE_NAME, BREAKER_TTL_SECONDS } from "./circuit-breaker";
import "./index";

vi.mock("hono/proxy", () => ({
  proxy: vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response("<html><head><meta property='og:title' content='Mocked' /></head></html>", {
        headers: { "Content-Type": "text/html" },
      })
    )
  ),
}));

const lastUpstreamHeaders = (): Headers => {
  expect(proxy).toHaveBeenCalledTimes(1);
  return new Headers(vi.mocked(proxy).mock.calls[0][1]?.headers);
};

describe("app route /", () => {
  beforeEach(() => {
    vi.mocked(proxy).mockClear();
  });

  it("returns 404 for an unknown route", async () => {
    const res = await SELF.fetch("https://proxy.example.com/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 400 when url param is missing", async () => {
    const res = await SELF.fetch("https://proxy.example.com/");
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid URL", async () => {
    const res = await SELF.fetch("https://proxy.example.com/?url=not-a-url");
    expect(res.status).toBe(400);
  });

  it("returns 400 when url has the same origin as the worker", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://proxy.example.com/other"
    );
    expect(res.status).toBe(400);
  });

  it("returns OGP JSON when Accept is application/json", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.com/page",
      { headers: { Accept: "application/json" } }
    );
    expect(res.status).toBe(200);
    const json = await res.json<Record<string, string>>();
    expect(json["og:title"]).toBe("Mocked");
    expect(lastUpstreamHeaders().get("Accept")).toBe("text/html");
  });

  it("returns 200 JSON for a 204 upstream response in OGP JSON mode", async () => {
    vi.mocked(proxy).mockImplementationOnce(async () => new Response(null, { status: 204 }));

    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.org/no-content",
      { headers: { Accept: "application/json" } }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("preserves a 404 upstream status in OGP JSON mode", async () => {
    vi.mocked(proxy).mockImplementationOnce(async () =>
      new Response("<title>Missing</title><meta property='og:title' content='Missing' />", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      })
    );

    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.org/missing",
      { headers: { Accept: "application/json" } }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ "og:title": "Missing", title: "Missing" });
  });

  it("preserves a 503 upstream status in OGP JSON mode", async () => {
    vi.mocked(proxy).mockImplementationOnce(async () =>
      new Response("<title>Unavailable</title><meta property='og:title' content='Unavailable' />", {
        status: 503,
        headers: { "Content-Type": "text/html" },
      })
    );

    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.net/unavailable",
      { headers: { Accept: "application/json" } }
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      "og:title": "Unavailable",
      title: "Unavailable",
    });
    expect(
      await (await caches.open(BREAKER_CACHE_NAME)).match("https://example.net/")
    ).toBeUndefined();
  });

  it("forwards a non-JSON Accept header unchanged", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.org/html",
      { headers: { Accept: "text/html" } }
    );
    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders().get("Accept")).toBe("text/html");
  });

  it("forwards multiple non-JSON media types unchanged", async () => {
    const accept = "image/avif,image/webp,*/*";
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.net/image",
      { headers: { Accept: accept } }
    );

    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders().get("Accept")).toBe(accept);
  });

  it("does not add Accept when the incoming request has none", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.org/no-accept"
    );

    expect(res.status).toBe(200);
    expect(lastUpstreamHeaders().has("Accept")).toBe(false);
  });

  it("does not forward incoming credentials or proxy metadata", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=https://example.net/private",
      {
        headers: {
          Accept: "*/*",
          "Accept-Encoding": "gzip",
          "Accept-Language": "en-US",
          Authorization: "Bearer secret",
          "CF-Connecting-IP": "192.0.2.1",
          Cookie: "session=secret",
          "If-Range": '"example-etag"',
          Origin: "https://example.com",
          Range: "bytes=0-99",
          Referer: "https://example.com/page",
          "User-Agent": "example-client",
          "X-Forwarded-For": "192.0.2.1",
          "X-Forwarded-Host": "proxy.example.com",
          "X-Forwarded-Proto": "https",
          "X-Real-IP": "192.0.2.1",
        },
      }
    );

    expect(res.status).toBe(200);
    const headers = lastUpstreamHeaders();
    expect(headers.get("Accept")).toBe("*/*");
    for (const name of [
      "Accept-Encoding",
      "Accept-Language",
      "Authorization",
      "CF-Connecting-IP",
      "Cookie",
      "Host",
      "If-Range",
      "Origin",
      "Range",
      "Referer",
      "User-Agent",
      "X-Forwarded-For",
      "X-Forwarded-Host",
      "X-Forwarded-Proto",
      "X-Real-IP",
    ]) {
      expect(headers.has(name)).toBe(false);
    }
  });

  it.each(["GET", "HEAD"] as const)(
    "does not expose upstream resource hints for %s requests",
    async (method) => {
      vi.mocked(proxy).mockImplementationOnce(async () =>
        new Response("upstream body", {
          status: 202,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Link: '<./_app/immutable/entry/start.js>; rel="modulepreload"',
          },
        })
      );

      const res = await SELF.fetch(
        `https://proxy.example.com/?url=https://${method.toLowerCase()}-link.example/page`,
        { method, headers: { Accept: "text/html" } }
      );

      expect(res.status).toBe(202);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Link")).toBeNull();
      expect(await res.text()).toBe(method === "GET" ? "upstream body" : "");
    }
  );

  it("returns CORS headers on OPTIONS request", async () => {
    const res = await SELF.fetch("https://proxy.example.com/", {
      method: "OPTIONS",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("returns 400 for data: URL", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=data:text/html,hello"
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for file: URL", async () => {
    const res = await SELF.fetch(
      "https://proxy.example.com/?url=file:///etc/passwd"
    );
    expect(res.status).toBe(400);
  });

  it("rejects upstream URLs containing credentials before proxying", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const withUsername = await SELF.fetch(
      "https://proxy.example.com/?url=https://user@username-credentials.example/page"
    );
    const withPassword = await SELF.fetch(
      "https://proxy.example.com/?url=https://:password@password-credentials.example/page"
    );

    expect(withUsername.status).toBe(400);
    expect(withPassword.status).toBe(400);
    expect(await withUsername.text()).toBe("Bad Request");
    expect(await withPassword.text()).toBe("Bad Request");
    expect(proxy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const breakerCache = await caches.open(BREAKER_CACHE_NAME);
    expect(
      await breakerCache.match("https://username-credentials.example/")
    ).toBeUndefined();
    expect(
      await breakerCache.match("https://password-credentials.example/")
    ).toBeUndefined();

    errorSpy.mockRestore();
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
        "Too many redirects at https://broken.example/private?token=secret"
      )
    );

    const first = await SELF.fetch(
      "https://proxy.example.com/?url=https://broken.example/private?token=secret"
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

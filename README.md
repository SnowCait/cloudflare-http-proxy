# Cloudflare HTTP Proxy

[![Test](https://github.com/SnowCait/cloudflare-http-proxy/actions/workflows/test.yml/badge.svg)](https://github.com/SnowCait/cloudflare-http-proxy/actions/workflows/test.yml)

A small HTTP proxy running on Cloudflare Workers (built with [Hono](https://hono.dev/)).
It proxies a remote resource passed via the `url` query parameter, and can also return a
page's [Open Graph](https://ogp.me/) metadata as JSON.

## Usage

### Proxy a resource

```
GET https://<worker>/?url=https://example.com/image.png
```

- The `url` value should be URL-encoded.
- `url` must be a valid absolute URL and must not point back to the proxy's own origin
  (otherwise the request returns `404`).
- Supported methods: `OPTIONS`, `HEAD`, `GET`.
- Responses are cached, CORS headers are applied, and the upstream request includes
  `X-Forwarded-For` / `X-Forwarded-Host` headers.

### Get OGP metadata as JSON

Send `Accept: application/json` to receive the target page's OGP metadata as JSON
instead of the proxied response:

```
curl -H "Accept: application/json" "https://<worker>/?url=https://example.com"
```

```json
{
  "og:title": "Example",
  "og:description": "An example page",
  "og:image": "https://example.com/image.png",
  "twitter:card": "summary_large_image",
  "description": "An example page",
  "title": "Example"
}
```

It extracts `og:*`, `twitter:*`, and `description` meta tags, and falls back to the
`<title>` element for the `title` key. The JSON response inherits the origin's
`Cache-Control` and is cached separately from proxied responses.

## Configuration

- `CORS_ORIGIN` — comma-separated list of allowed origins. Defaults to `*`.

## Development

```
npm install
npm run dev
```

## Deploy

```
npm run deploy
```

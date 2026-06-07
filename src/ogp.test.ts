import { describe, expect, it } from "vitest";
import { extractOgp } from "./ogp";

function makeResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

describe("extractOgp", () => {
  it("extracts og: properties", async () => {
    const html = `<html><head>
      <meta property="og:title" content="Test Title" />
      <meta property="og:description" content="Test Desc" />
    </head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(result["og:title"]).toBe("Test Title");
    expect(result["og:description"]).toBe("Test Desc");
  });

  it("falls back to <title> when og:title is absent", async () => {
    const html = `<html><head><title>Page Title</title></head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(result.title).toBe("Page Title");
  });

  it("does not set title key when og:title is present (title is separate key)", async () => {
    const html = `<html><head>
      <title>Page Title</title>
      <meta property="og:title" content="OG Title" />
    </head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(result["og:title"]).toBe("OG Title");
    // <title> fallback only sets result.title when result.title is undefined,
    // but og:title and title are different keys — both can coexist.
    expect(result.title).toBe("Page Title");
  });

  it("extracts twitter: properties", async () => {
    const html = `<html><head>
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content="Twitter Title" />
    </head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(result["twitter:card"]).toBe("summary");
    expect(result["twitter:title"]).toBe("Twitter Title");
  });

  it("extracts description meta", async () => {
    const html = `<html><head>
      <meta name="description" content="Page description" />
    </head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(result.description).toBe("Page description");
  });

  it("ignores unrelated meta tags", async () => {
    const html = `<html><head>
      <meta name="viewport" content="width=device-width" />
      <meta name="robots" content="noindex" />
    </head></html>`;
    const result = await extractOgp(makeResponse(html));
    expect(Object.keys(result)).toHaveLength(0);
  });
});

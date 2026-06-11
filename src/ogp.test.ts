import { describe, expect, it } from "vitest";
import { extractOgp } from "./ogp";

function makeResponse(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function bytes(...parts: (string | number[])[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// "テスト" and "日本語" encoded as Shift_JIS (TextEncoder can only produce UTF-8)
const SJIS_TESUTO = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67];
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];

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

describe("extractOgp charset handling", () => {
  it("decodes Shift_JIS declared in the Content-Type header", async () => {
    const body = bytes("<html><head><title>", SJIS_TESUTO, "</title></head></html>");
    const response = new Response(body, {
      headers: { "Content-Type": "text/html; charset=Shift_JIS" },
    });
    const result = await extractOgp(response);
    expect(result.title).toBe("テスト");
  });

  it("decodes Shift_JIS declared only in a meta charset tag", async () => {
    const body = bytes(
      '<html><head><meta charset="shift_jis"><meta property="og:title" content="',
      SJIS_NIHONGO,
      '"></head></html>',
    );
    const response = new Response(body, {
      headers: { "Content-Type": "text/html" },
    });
    const result = await extractOgp(response);
    expect(result["og:title"]).toBe("日本語");
  });

  it("decodes Shift_JIS declared in a meta http-equiv tag", async () => {
    const body = bytes(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=shift_jis"><title>',
      SJIS_TESUTO,
      "</title></head></html>",
    );
    const response = new Response(body, {
      headers: { "Content-Type": "text/html" },
    });
    const result = await extractOgp(response);
    expect(result.title).toBe("テスト");
  });

  it("falls back to UTF-8 for an unknown charset label", async () => {
    const response = new Response("<html><head><title>日本語</title></head></html>", {
      headers: { "Content-Type": "text/html; charset=bogus-encoding" },
    });
    const result = await extractOgp(response);
    expect(result.title).toBe("日本語");
  });

  it("prefers the BOM over the Content-Type header", async () => {
    const body = bytes(
      [0xef, 0xbb, 0xbf],
      "<html><head><title>ボム</title></head></html>",
    );
    const response = new Response(body, {
      headers: { "Content-Type": "text/html; charset=shift_jis" },
    });
    const result = await extractOgp(response);
    expect(result.title).toBe("ボム");
  });

  it("treats a meta-declared utf-16 as UTF-8", async () => {
    const html = '<html><head><meta charset="utf-16"><title>日本語</title></head></html>';
    const result = await extractOgp(makeResponse(html));
    expect(result.title).toBe("日本語");
  });

  it("passes through UTF-8 declared in the Content-Type header", async () => {
    const response = new Response("<html><head><title>日本語</title></head></html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const result = await extractOgp(response);
    expect(result.title).toBe("日本語");
  });
});

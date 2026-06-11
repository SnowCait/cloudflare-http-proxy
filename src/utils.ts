const CHARSET_RE = /charset\s*=\s*["']?([^"';\s]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i;

function decoderFor(label: string | undefined): TextDecoder | null {
  if (label === undefined) {
    return null;
  }
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

function bomDecoder(bytes: Uint8Array): TextDecoder | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8");
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be");
  }
  return null;
}

function metaDecoder(bytes: Uint8Array): TextDecoder | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const label = head.match(META_CHARSET_RE)?.[1];
  if (label !== undefined && /^utf-?16/i.test(label)) {
    // HTML spec: utf-16 declared in an ASCII-compatible meta tag means utf-8
    return new TextDecoder("utf-8");
  }
  return decoderFor(label);
}

export async function toUtf8Response(response: Response): Promise<Response> {
  const headerDecoder = decoderFor(
    response.headers.get("Content-Type")?.match(CHARSET_RE)?.[1],
  );
  if (headerDecoder?.encoding === "utf-8") {
    return response;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoder = bomDecoder(bytes) ?? headerDecoder ?? metaDecoder(bytes);
  if (decoder === null || decoder.encoding === "utf-8") {
    return new Response(bytes);
  }
  return new Response(decoder.decode(bytes));
}

export function wantsJson(accept: string | undefined): boolean {
  return (
    accept
      ?.split(",")
      .some((type) => type.trim().split(";")[0].trim() === "application/json") ??
    false
  );
}

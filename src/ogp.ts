import { toUtf8Response } from "./utils";

export async function extractOgp(response: Response): Promise<Record<string, string>> {
  const utf8Response = await toUtf8Response(response);
  const ogp: Record<string, string> = {};
  let title = "";

  const rewriter = new HTMLRewriter()
    .on("meta", {
      element(element) {
        const property =
          element.getAttribute("property") ?? element.getAttribute("name");
        const content = element.getAttribute("content");
        if (property === null || content === null) {
          return;
        }
        if (
          property.startsWith("og:") ||
          property.startsWith("twitter:") ||
          property === "description"
        ) {
          ogp[property] = content;
        }
      },
    })
    .on("title", {
      text(text) {
        title += text.text;
      },
    });

  await rewriter.transform(utf8Response).arrayBuffer();

  if (title !== "" && ogp.title === undefined) {
    ogp.title = title;
  }

  return ogp;
}

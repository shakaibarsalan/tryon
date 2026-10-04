// Parse what the user dragged into the side panel. Pure: takes a getData function.

/** The URL of an image dragged from a web page, if any. Only http(s) and image data URLs. */
export function parseDropUrl(getData: (type: string) => string): string | undefined {
  const accept = (raw: string | undefined | null): string | undefined => {
    const s = (raw || "").trim();
    if (!s) return undefined;
    if (/^data:image\/(jpeg|png|webp|gif|avif);base64,/i.test(s)) return s;
    try {
      const u = new URL(s);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
    } catch {
      return undefined;
    }
  };

  // text/html first: when an <img> inside a link is dragged, uri-list holds the link, html holds the image.
  const html = safeGet(getData, "text/html");
  if (html) {
    const m = /<img\b[^>]*?\bsrc\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
    const src = m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
    const fromHtml = accept(src);
    if (fromHtml) return fromHtml;
  }

  const list = safeGet(getData, "text/uri-list");
  if (list) {
    for (const line of list.split(/\r?\n/)) {
      if (line.startsWith("#")) continue;
      const u = accept(line);
      if (u) return u;
    }
  }
  return accept(safeGet(getData, "text/plain"));
}

function safeGet(getData: (type: string) => string, type: string): string {
  try {
    return getData(type) || "";
  } catch {
    return "";
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

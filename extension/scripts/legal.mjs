// Turns the plain-English legal docs (docs/legal/*.md) into pages for the extension and the web
// site, so there is one copy of each text. Handles only the Markdown those files use: #, ## and ###
// headings, paragraphs, "- " lists, **bold**, `code` and [links](url). Links to a sibling .md file
// become .html; anything that isn't http(s) or a sibling page is dropped to plain text.

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown to HTML (escaped). */
export function inlineHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = /^[a-z0-9-]+\.md$/i.test(href) ? href.replace(/\.md$/i, ".html") : href;
    if (/^https?:\/\//i.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    if (/^[a-z0-9-]+\.html$/i.test(url)) return `<a href="${url}">${label}</a>`;
    return label;
  });
  return out;
}

/** @returns {{ title: string, html: string }} */
export function markdownToHtml(md) {
  const out = [];
  let title = "";
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>\n${list.map((item) => `  <li>${inlineHtml(item)}</li>`).join("\n")}\n</ul>`);
    list = null;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) {
      flushPara();
      flushList();
    } else if ((m = /^(#{1,3}) (.+)$/.exec(line))) {
      flushPara();
      flushList();
      const level = m[1].length;
      if (level === 1 && !title) title = m[2];
      out.push(`<h${level}>${inlineHtml(m[2])}</h${level}>`);
    } else if ((m = /^- (.+)$/.exec(line))) {
      flushPara();
      (list ??= []).push(m[1]);
    } else if (list && /^\s/.test(raw)) {
      list[list.length - 1] += ` ${line}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return { title, html: out.join("\n") };
}

/** A complete page around converted Markdown. `cssPrefix` is the path to the css/ folder. */
export function legalPage(md, { brandName, cssPrefix = "" }) {
  const { title, html } = markdownToHtml(md);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title || brandName)}</title>
  <link rel="stylesheet" href="${cssPrefix}css/base.css">
  <link rel="stylesheet" href="${cssPrefix}css/legal.css">
</head>
<body>
<main class="legal">
${html}
<p class="legal-foot"><a href="privacy.html">Privacy notice</a> · <a href="terms.html">Terms of use</a></p>
</main>
</body>
</html>
`;
}

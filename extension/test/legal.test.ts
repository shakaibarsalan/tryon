/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineHtml, legalPage, markdownToHtml } from "../scripts/legal.mjs";

const docs = join(__dirname, "..", "..", "docs", "legal");

describe("legal page converter", () => {
  it("handles headings, paragraphs, lists and inline marks", () => {
    const md = "# Title\n\nLast updated: today\n\n## Part one\n\nLine one\nline two.\n\n- **Bold** item\n- `code` and a [link](https://example.com)\n  wrapped\n\nAfter.";
    const { title, html } = markdownToHtml(md);
    expect(title).toBe("Title");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Part one</h2>");
    expect(html).toContain("<p>Line one line two.</p>");
    expect(html).toContain("<li><strong>Bold</strong> item</li>");
    expect(html).toContain('<li><code>code</code> and a <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a> wrapped</li>');
    expect(html).toContain("<p>After.</p>");
  });

  it("escapes HTML and keeps only safe links", () => {
    expect(inlineHtml("<script>alert(1)</script> & \"x\"")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;");
    expect(inlineHtml("[bad](javascript:void0)")).toBe("bad");
    expect(inlineHtml("[x](data:text/html,hi)")).toBe("x");
    expect(inlineHtml("[terms](terms.md)")).toBe('<a href="terms.html">terms</a>');
  });

  it("builds both real pages with their titles and cross links", () => {
    for (const [name, title] of [["privacy", "Try-On privacy notice"], ["terms", "Try-On terms of use"]] as const) {
      const page = legalPage(readFileSync(join(docs, `${name}.md`), "utf8"), { brandName: "Try-On" });
      expect(page).toContain(`<title>${title}</title>`);
      expect(page).toContain('href="css/legal.css"');
      expect(page).toContain('<a href="privacy.html">Privacy notice</a>');
      expect(page).not.toMatch(/—|–/); // no dashes in the prose
    }
  });
});

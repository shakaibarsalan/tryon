// Test helpers: load an HTML fixture at a given URL and fake layout sizes (happy-dom has no layout).

export interface Fixture {
  url: string;
  html: string;
}

/** Parse a fixture as its own document whose URL is `fixture.url`. */
export function load(fixture: Fixture): Document {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(fixture.url);
  return new DOMParser().parseFromString(fixture.html, "text/html");
}

/** Sizes come from data-test-w / data-test-h (and optional data-test-x / data-test-y). */
export function measure(el: Element): { width: number; height: number; x?: number; y?: number } {
  const width = Number(el.getAttribute("data-test-w") || 0);
  const height = Number(el.getAttribute("data-test-h") || 0);
  const x = el.getAttribute("data-test-x");
  const y = el.getAttribute("data-test-y");
  return x !== null && y !== null ? { width, height, x: Number(x), y: Number(y) } : { width, height };
}

export const opts = { measure };

export function byId(doc: Document | ShadowRoot, id: string): HTMLImageElement {
  const el = doc.querySelector(`#${id}`);
  if (!el) throw new Error(`fixture has no #${id}`);
  return el as HTMLImageElement;
}

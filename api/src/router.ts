// Minimal method + path router with ":param" segments.

export type Params = Record<string, string>;
export type Handler<C> = (ctx: C, params: Params) => Promise<Response>;

interface Route<C> {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler<C>;
}

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  on(method: string, path: string, handler: Handler<C>): this {
    const keys: string[] = [];
    const pattern = path
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([A-Za-z0-9_-]{1,64})";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, regex: new RegExp(`^${pattern}/?$`), keys, handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler<C>; params: Params } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]!));
      return { handler: r.handler, params };
    }
    return null;
  }
}

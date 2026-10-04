// CORS: reflect the request Origin when it matches one of ALLOWED_ORIGINS.
// Patterns: "chrome-extension://*", "http://localhost:*", "https://*.example.com", "https://app.example.com".
// "*" as the host matches any host; "*." as a host prefix matches subdomains; ":*" matches any port (or none).
import { HEADER_IDEMPOTENCY_KEY, HEADER_INSTALL_TOKEN } from "@tryon/shared";

interface OriginPattern {
  scheme: string;
  host: string;
  port: string | null;
}

function parsePattern(p: string): OriginPattern | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\*|\d+))?\/?$/i.exec(p.trim());
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), port: m[3] ?? null };
}

function parseOrigin(origin: string): OriginPattern | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\d+))?$/i.exec(origin);
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), port: m[3] ?? null };
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return host.length > 0;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

export function originAllowed(origin: string | null, patterns: string[]): boolean {
  if (!origin || origin === "null") return false;
  const o = parseOrigin(origin);
  if (!o) return false;
  for (const raw of patterns) {
    const p = parsePattern(raw);
    if (!p || p.scheme !== o.scheme || !hostMatches(p.host, o.host)) continue;
    if (p.port === "*" || p.port === o.port) return true;
  }
  return false;
}

const ALLOW_HEADERS = ["Content-Type", HEADER_INSTALL_TOKEN, HEADER_IDEMPOTENCY_KEY].join(", ");
const EXPOSE_HEADERS = ["Retry-After", "Idempotent-Replayed"].join(", ");

export function corsHeaders(origin: string | null, patterns: string[]): Record<string, string> {
  if (!origin || !originAllowed(origin, patterns)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": EXPOSE_HEADERS,
    Vary: "Origin",
  };
}

/** Response to an OPTIONS preflight. Disallowed origins get 403 without CORS headers. */
export function preflight(request: Request, patterns: string[]): Response {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin, patterns)) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin, patterns),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function withCors(response: Response, request: Request, patterns: string[]): Response {
  const headers = corsHeaders(request.headers.get("Origin"), patterns);
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// "Sign in with Google": checks a Google ID token (a JWT signed RS256 with one of Google's keys).
// We keep nothing from it but the account id (`sub`), and store only a keyed hash of that.
// Docs: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
import { HttpError } from "./errors";
import type { FetchLike } from "./providers/types";
import { base64UrlDecode, utf8 } from "./util";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_S = 120;
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface KeyCache {
  keys: Jwk[];
  expires: number;
}

let cache: KeyCache | undefined;

/** Test helper. */
export function resetGoogleKeys(): void {
  cache = undefined;
}

function maxAgeMs(res: Response): number {
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  return m ? Math.min(Number(m[1]) * 1000, 24 * 60 * 60 * 1000) : DEFAULT_KEYS_TTL_MS;
}

async function googleKeys(doFetch: FetchLike, now: number, refresh: boolean): Promise<Jwk[]> {
  if (cache && !refresh && cache.expires > now) return cache.keys;
  let res: Response;
  try {
    res = await doFetch(GOOGLE_JWKS_URL, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new HttpError("provider_error", `Couldn't reach Google to check the sign-in: ${(e as Error).message}`);
  }
  if (!res.ok) throw new HttpError("provider_error", `Google's key service answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  const keys = Array.isArray(body?.keys) ? body!.keys.filter((k) => k && k.kty === "RSA" && k.kid && k.n && k.e) : [];
  cache = { keys, expires: now + maxAgeMs(res) };
  return keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface GoogleIdentity {
  /** Google's stable account id. */
  sub: string;
}

export interface VerifyOptions {
  clientIds: string[];
  fetch?: FetchLike;
  now?: number;
}

/** Returns the account id when the token is genuine, fresh and meant for one of our client ids. */
export async function verifyGoogleIdToken(idToken: unknown, o: VerifyOptions): Promise<GoogleIdentity> {
  const bad = (why: string) => new HttpError("unauthorized", `Google sign-in was not accepted: ${why}`);
  if (!o.clientIds.length) throw new HttpError("not_found", "Sign-in is not set up on this server");
  if (typeof idToken !== "string" || idToken.length > 4096) throw bad("missing token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw bad("malformed token");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const claims = decodeJson(p);
  if (!header || !claims) throw bad("malformed token");
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw bad("unexpected algorithm");

  const now = o.now ?? Date.now();
  const doFetch: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));
  let jwk = (await googleKeys(doFetch, now, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(doFetch, now, true)).find((k) => k.kid === header.kid); // Google rotated its keys
  if (!jwk) throw bad("unknown signing key");

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(s);
  } catch {
    throw bad("malformed signature");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const genuine = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, utf8(`${h}.${p}`));
  if (!genuine) throw bad("bad signature");

  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) throw bad("wrong issuer");
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.some((a) => typeof a === "string" && o.clientIds.includes(a))) throw bad("token is for another app");
  const nowS = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw bad("token expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > nowS) throw bad("token from the future");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw bad("no account id");
  return { sub: claims.sub };
}

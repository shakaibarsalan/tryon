// Install tokens: base64url(JSON{install_id, iat}) + "." + base64url(HMAC-SHA256(secret, payloadPart)).
// They only count usage per install (Phase 0); they are not strong identity.
import { isProduction, type Env } from "./env";
import { HttpError } from "./errors";
import { base64UrlDecode, base64UrlEncode, toHex, utf8 } from "./util";

/** Public, insecure fallback used only outside production when INSTALL_TOKEN_SECRET is unset. */
const DEV_FALLBACK_SECRET = "dev-only-INSECURE-install-token-secret-do-not-use-in-production";
let warnedFallback = false;

export function tokenSecret(env: Env): string {
  const secret = env.INSTALL_TOKEN_SECRET?.trim();
  if (secret) return secret;
  if (isProduction(env)) {
    throw new HttpError("internal", "Server misconfigured: INSTALL_TOKEN_SECRET is not set");
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      "[tryon-api] INSTALL_TOKEN_SECRET is not set: using the DEV-ONLY insecure fallback secret. " +
        "Never run like this in production (ENVIRONMENT=production refuses it).",
    );
  }
  return DEV_FALLBACK_SECRET;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(message));
  return new Uint8Array(sig);
}

export interface TokenPayload {
  install_id: string;
  iat: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function signInstallToken(secret: string, payload: TokenPayload): Promise<string> {
  const body = base64UrlEncode(utf8(JSON.stringify({ install_id: payload.install_id, iat: payload.iat })));
  const sig = base64UrlEncode(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}

/** Returns the payload when the signature is valid, otherwise null. */
export async function verifyInstallToken(secret: string, token: string): Promise<TokenPayload | null> {
  if (token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  let sigBytes: Uint8Array;
  let payload: unknown;
  try {
    sigBytes = base64UrlDecode(sig);
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, utf8(body));
  if (!ok) return null;
  if (!payload || typeof payload !== "object") return null;
  const { install_id, iat } = payload as Record<string, unknown>;
  if (typeof install_id !== "string" || !UUID_RE.test(install_id)) return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  return { install_id, iat };
}

/** HMAC of (day, ip) so raw IPs are never stored and hashes rotate daily. */
export async function hashIp(secret: string, day: string, ip: string): Promise<string> {
  return toHex(await hmacSha256(secret, `ip:${day}:${ip}`)).slice(0, 32);
}

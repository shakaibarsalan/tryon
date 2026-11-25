import { HEADER_ACCOUNT_TOKEN, HEADER_INSTALL_TOKEN, type AccountToken, type QuotaView, type RenderJob, type ServerConfig } from "@tryon/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_JWKS_URL, resetGoogleKeys, verifyGoogleIdToken } from "../src/google";
import { createMockProvider } from "../src/providers/mock";
import type { FetchLike } from "../src/providers/types";
import { signAccountToken, signInstallToken, verifyAccountToken, verifyInstallToken } from "../src/token";
import { base64UrlEncode, utf8 } from "../src/util";
import { body, errorCode, harness } from "./helpers";

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** A stand-in for Google: an RSA key pair, its JWKS endpoint and an ID-token signer. */
async function fakeGoogle(kid = "key-1") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  let fetches = 0;
  const fetch: FetchLike = async (url) => {
    fetches++;
    expect(url).toBe(GOOGLE_JWKS_URL);
    return new Response(JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid, n: jwk.n, e: jwk.e }] }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  };
  async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid, typ: "JWT" }) {
    const h = base64UrlEncode(utf8(JSON.stringify(header)));
    const p = base64UrlEncode(utf8(JSON.stringify(claims)));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, utf8(`${h}.${p}`)));
    return `${h}.${p}.${base64UrlEncode(sig)}`;
  }
  const idToken = (over: Record<string, unknown> = {}) =>
    sign({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "109876543210",
      email: "someone@example.com",
      iat: NOW / 1000 - 10,
      exp: NOW / 1000 + 3600,
      ...over,
    });
  return { fetch, sign, idToken, fetches: () => fetches };
}

beforeEach(() => resetGoogleKeys());

describe("Google ID token check", () => {
  it("accepts a genuine, fresh token for our client id and caches Google's keys", async () => {
    const g = await fakeGoogle();
    const o = { clientIds: [CLIENT_ID], fetch: g.fetch, now: NOW };
    expect(await verifyGoogleIdToken(await g.idToken(), o)).toEqual({ sub: "109876543210" });
    expect(await verifyGoogleIdToken(await g.idToken({ iss: "accounts.google.com", aud: ["other", CLIENT_ID] }), o)).toEqual({
      sub: "109876543210",
    });
    expect(g.fetches()).toBe(1);
  });

  it("rejects tokens for another app, expired, from another issuer or without an account id", async () => {
    const g = await fakeGoogle();
    const o = { clientIds: [CLIENT_ID], fetch: g.fetch, now: NOW };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ aud: "someone-else.apps.googleusercontent.com" }, /another app/],
      [{ exp: NOW / 1000 - 3600 }, /expired/],
      [{ iat: NOW / 1000 + 3600 }, /future/],
      [{ iss: "https://evil.example" }, /issuer/],
      [{ sub: "" }, /account id/],
    ];
    for (const [over, why] of cases) {
      await expect(verifyGoogleIdToken(await g.idToken(over), o)).rejects.toMatchObject({ code: "unauthorized", message: expect.stringMatching(why) });
    }
  });

  it("rejects forged signatures, other algorithms and unknown keys", async () => {
    const g = await fakeGoogle();
    const other = await fakeGoogle();
    const o = { clientIds: [CLIENT_ID], fetch: g.fetch, now: NOW };
    await expect(verifyGoogleIdToken(await other.idToken(), o)).rejects.toThrow(/bad signature/);
    const [h, p] = (await g.idToken()).split(".");
    await expect(verifyGoogleIdToken(`${h}.${p}.`, o)).rejects.toThrow(/bad signature|malformed/);
    const none = `${base64UrlEncode(utf8(JSON.stringify({ alg: "none", kid: "key-1" })))}.${p}.`;
    await expect(verifyGoogleIdToken(none, o)).rejects.toThrow(/algorithm/);
    const unknownKid = await g.sign({ aud: CLIENT_ID }, { alg: "RS256", kid: "rotated-away" });
    await expect(verifyGoogleIdToken(unknownKid, o)).rejects.toThrow(/unknown signing key/);
    expect(g.fetches()).toBe(2); // the unknown kid made it fetch fresh keys once
    await expect(verifyGoogleIdToken("not.a.jwt", o)).rejects.toThrow(/malformed/);
    await expect(verifyGoogleIdToken(undefined, o)).rejects.toThrow(/missing/);
    await expect(verifyGoogleIdToken(await g.idToken(), { ...o, clientIds: [] })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("account tokens", () => {
  it("can't be swapped with install tokens", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const account = await signAccountToken("s", { account_id: id, iat: 5 });
    const install = await signInstallToken("s", { install_id: id, iat: 5 });
    expect(await verifyAccountToken("s", account)).toEqual({ account_id: id, iat: 5 });
    expect(await verifyAccountToken("other", account)).toBeNull();
    expect(await verifyAccountToken("s", install)).toBeNull();
    expect(await verifyInstallToken("s", account)).toBeNull();
    expect(await verifyAccountToken("s", `x${account}`)).toBeNull();
  });
});

describe("sign-in through the API", () => {
  async function setup(env: Record<string, string> = {}) {
    const g = await fakeGoogle();
    const h = harness({
      env: { GOOGLE_CLIENT_ID: CLIENT_ID, ACCOUNT_RENDERS_PER_MONTH: "2", FREE_RENDERS_PER_INSTALL: "1", ...env },
      googleFetch: g.fetch,
      now: () => NOW,
      providers: { mock: createMockProvider({ now: () => NOW }) },
    });
    return { g, h };
  }

  async function signIn(h: Awaited<ReturnType<typeof setup>>["h"], idToken: string): Promise<AccountToken> {
    const res = await h.call("POST", "/v1/auth/google", { body: { id_token: idToken } });
    expect(res.status).toBe(200);
    return (await res.json()) as AccountToken;
  }

  it("advertises sign-in in /v1/config only when a client id is set", async () => {
    const { h } = await setup();
    expect((await (await h.call("GET", "/v1/config")).json()) as ServerConfig).toEqual({
      provider: "mock",
      free_renders_per_install: 1,
      account_renders_per_month: 2,
      google_client_id: CLIENT_ID,
    });
    const off = harness();
    expect(((await (await off.call("GET", "/v1/config")).json()) as ServerConfig).google_client_id).toBeUndefined();
    const res = await off.call("POST", "/v1/auth/google", { body: { id_token: "x.y.z" } });
    expect(res.status).toBe(404);
  });

  it("keeps one account per Google account and stores no email", async () => {
    const { g, h } = await setup();
    const first = await signIn(h, await g.idToken());
    const again = await signIn(h, await g.idToken());
    expect(first.account_token).toMatch(/^a1\./);
    expect(first).toMatchObject({ renders_left_this_month: 2, renders_per_month: 2 });
    expect(h.store.accounts.size).toBe(1);
    const stored = JSON.stringify([...h.store.accounts.values()]);
    expect(stored).not.toContain("109876543210");
    expect(stored).not.toContain("example.com");
    expect((await verifyAccountToken("test-secret-0123456789", again.account_token))?.account_id).toBe(
      (await verifyAccountToken("test-secret-0123456789", first.account_token))?.account_id,
    );
    const bad = await h.call("POST", "/v1/auth/google", { body: { id_token: await g.idToken({ aud: "nope" }) } });
    expect([bad.status, await errorCode(bad)]).toEqual([401, "unauthorized"]);
  });

  it("uses the install's free renders first, then the account's monthly ones", async () => {
    const { g, h } = await setup();
    const { token } = await h.install();
    expect((await h.render(token)).status).toBe(202); // the 1 free install render

    const noAccount = await h.render(token);
    expect(noAccount.status).toBe(402);
    expect(((await noAccount.json()) as { error: { message: string } }).error.message).toMatch(/Sign in for 2 more every month/);

    const { account_token } = await signIn(h, await g.idToken());
    const withAccount = (extra: Record<string, string> = {}) =>
      h.call("POST", "/v1/renders", {
        body: body(),
        headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: account_token, "Idempotency-Key": crypto.randomUUID(), ...extra },
      });
    expect((await withAccount()).status).toBe(202);
    const me = (await (await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: account_token } })).json()) as QuotaView;
    expect(me).toMatchObject({ free_renders_left: 0, account: { renders_left_this_month: 1, renders_per_month: 2 } });
    expect((await withAccount()).status).toBe(202);
    const used = await withAccount();
    expect(used.status).toBe(402);
    expect(((await used.json()) as { error: { message: string } }).error.message).toMatch(/2 free renders for this month/);
    expect([...h.store.renders.values()].filter((r) => r.account_id).length).toBe(2);

    // A bad or stale account token is ignored (the install token stays valid), not a 401.
    const stale = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: "a1.bad.token" } });
    expect(stale.status).toBe(200);
    expect(((await stale.json()) as QuotaView).account).toBeUndefined();
  });

  it("gives the account's render back when the provider fails", async () => {
    const { g, h } = await setup({ FREE_RENDERS_PER_INSTALL: "0" });
    const { token } = await h.install();
    const { account_token } = await signIn(h, await g.idToken());
    const res = await h.call("POST", "/v1/renders", {
      body: body({ client_ref: "mock:fail" }),
      headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: account_token, "Idempotency-Key": "k1" },
    });
    const job = (await res.json()) as RenderJob;
    await h.get(token, job.id);
    const failed = (await (await h.get(token, job.id)).json()) as RenderJob;
    expect(failed.status).toBe("failed");
    const me = (await (await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: account_token } })).json()) as QuotaView;
    expect(me.account?.renders_left_this_month).toBe(2);
  });

  it("deletes the account too on DELETE /v1/me", async () => {
    const { g, h } = await setup();
    const { token } = await h.install();
    const { account_token } = await signIn(h, await g.idToken());
    const res = await h.call("DELETE", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: token, [HEADER_ACCOUNT_TOKEN]: account_token } });
    expect(res.status).toBe(200);
    expect(h.store.accounts.size).toBe(0);
    expect(h.store.installs.size).toBe(0);
  });
});

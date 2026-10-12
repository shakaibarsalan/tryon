import { HEADER_INSTALL_TOKEN, type QuotaView } from "@tryon/shared";
import { describe, expect, it } from "vitest";
import { signInstallToken, verifyInstallToken } from "../src/token";
import { base64UrlDecode, base64UrlEncode, utf8 } from "../src/util";
import { errorCode, harness } from "./helpers";

describe("POST /v1/installs and GET /v1/me", () => {
  it("mints a signed token with the free render quota", async () => {
    const h = harness();
    const t = await h.install();
    expect(t.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.free_renders_left).toBe(3);
    expect(t.token.split(".")).toHaveLength(2);
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(t.token.split(".")[0]!)));
    expect(payload.install_id).toBe(t.install_id);
    expect(typeof payload.iat).toBe("number");

    const me = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: t.token } });
    expect(me.status).toBe(200);
    expect((await me.json()) as QuotaView).toEqual({ install_id: t.install_id, free_renders_left: 3 });
  });

  it("rejects a missing, tampered or foreign-secret token", async () => {
    const h = harness();
    const t = await h.install();
    const [body, sig] = t.token.split(".") as [string, string];

    const missing = await h.call("GET", "/v1/me");
    expect(missing.status).toBe(401);
    expect(await errorCode(missing)).toBe("unauthorized");

    // Payload swapped to another install id, signature kept.
    const forgedBody = base64UrlEncode(utf8(JSON.stringify({ install_id: crypto.randomUUID(), iat: 1 })));
    const forged = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: `${forgedBody}.${sig}` } });
    expect(forged.status).toBe(401);

    // First signature character changed (the last one may only hold padding bits).
    const flipped = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
    const bad = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: `${body}.${flipped}` } });
    expect(bad.status).toBe(401);

    // Signed with a different secret.
    const other = await signInstallToken("another-secret", { install_id: t.install_id, iat: 1 });
    const wrong = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: other } });
    expect(wrong.status).toBe(401);

    const garbage = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: "not-a-token" } });
    expect(garbage.status).toBe(401);
  });

  it("verifies its own tokens and rejects malformed payloads", async () => {
    const tok = await signInstallToken("s", { install_id: "123e4567-e89b-42d3-a456-426614174000", iat: 42 });
    expect(await verifyInstallToken("s", tok)).toEqual({ install_id: "123e4567-e89b-42d3-a456-426614174000", iat: 42 });
    expect(await verifyInstallToken("t", tok)).toBeNull();
    const notUuid = await signInstallToken("s", { install_id: "../../etc", iat: 1 });
    expect(await verifyInstallToken("s", notUuid)).toBeNull();
  });

  it("rejects a valid token whose install no longer exists", async () => {
    const h = harness();
    const t = await h.install();
    h.store.installs.clear();
    const res = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: t.token } });
    expect(res.status).toBe(401);
  });

  it("uses the dev fallback secret outside production only", async () => {
    const dev = harness({ env: { INSTALL_TOKEN_SECRET: undefined, ENVIRONMENT: "development" } });
    const t = await dev.install();
    const me = await dev.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: t.token } });
    expect(me.status).toBe(200);

    const prod = harness({ env: { INSTALL_TOKEN_SECRET: undefined, ENVIRONMENT: "production" } });
    const res = await prod.call("POST", "/v1/installs");
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("internal");
  });

  it("returns JSON 404 for unknown routes", async () => {
    const h = harness();
    const res = await h.call("GET", "/v1/nope");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

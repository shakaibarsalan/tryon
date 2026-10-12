import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/cors";
import { harness } from "./helpers";

const DEFAULT = ["chrome-extension://*", "http://localhost:*", "http://127.0.0.1:*"];

describe("origin patterns", () => {
  it.each([
    ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", DEFAULT, true],
    ["http://localhost:5173", DEFAULT, true],
    ["http://localhost", DEFAULT, true],
    ["http://127.0.0.1:8787", DEFAULT, true],
    ["https://localhost:5173", DEFAULT, false],
    ["http://localhost.evil.com", DEFAULT, false],
    ["https://evil.com", DEFAULT, false],
    ["null", DEFAULT, false],
    ["moz-extension://abc", DEFAULT, false],
    ["https://shop.example.com", ["https://*.example.com"], true],
    ["https://example.com", ["https://*.example.com"], false],
    ["https://app.example.com:8443", ["https://app.example.com"], false],
    ["https://app.example.com", ["https://app.example.com"], true],
  ])("%s with %j -> %s", (origin, patterns, expected) => {
    expect(originAllowed(origin, patterns)).toBe(expected);
  });
});

describe("CORS handling", () => {
  it("answers an allowed preflight with 204 and the needed headers", async () => {
    const h = harness();
    const res = await h.call("OPTIONS", "/v1/renders", {
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-install-token,idempotency-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    const allowed = res.headers.get("Access-Control-Allow-Headers")!.toLowerCase();
    for (const hdr of ["content-type", "x-install-token", "idempotency-key"]) expect(allowed).toContain(hdr);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("refuses a preflight from a disallowed origin", async () => {
    const h = harness();
    const res = await h.call("OPTIONS", "/v1/renders", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("reflects allowed origins on normal and error responses only", async () => {
    const h = harness();
    const ok = await h.call("GET", "/v1/health", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(ok.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");

    const err = await h.call("GET", "/v1/me", { headers: { Origin: "http://localhost:5173" } });
    expect(err.status).toBe(401);
    expect(err.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");

    const evil = await h.call("GET", "/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const none = await h.call("GET", "/v1/health");
    expect(none.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

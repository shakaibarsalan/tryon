import { HEADER_INSTALL_TOKEN, type RenderJob } from "@tryon/shared";
import { describe, expect, it } from "vitest";
import { utcDay } from "../src/util";
import { body, errorCode, GARMENT, harness, paidProvider, PERSON } from "./helpers";

const json = async (res: Response) => (await res.json()) as RenderJob;

describe("render job lifecycle (mock provider)", () => {
  it("starts, processes, completes with an SVG composite, and re-serves the image", async () => {
    const h = harness();
    const t = await h.install();
    const start = await h.render(t.token, body({ client_ref: "local-7" }));
    expect(start.status).toBe(202);
    const job = await json(start);
    expect(job).toMatchObject({ status: "queued", provider: "mock", client_ref: "local-7" });
    expect(job.result_image).toBeUndefined();
    expect(new Date(job.created_at).toString()).not.toBe("Invalid Date");

    const p1 = await json(await h.get(t.token, job.id));
    expect(p1.status).toBe("processing");

    const p2 = await json(await h.get(t.token, job.id));
    expect(p2.status).toBe("completed");
    expect(typeof p2.ms).toBe("number");
    expect(p2.result_image).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = atob(p2.result_image!.split(",")[1]!);
    expect(svg).toContain("MOCK RENDER");
    expect(svg).toContain(`href="${PERSON}"`);
    expect(svg).toContain(`href="${GARMENT}"`);

    // Completed results are re-generated, never stored.
    const p3 = await json(await h.get(t.token, job.id));
    expect(p3.status).toBe("completed");
    expect(p3.result_image).toBe(p2.result_image);
    expect(JSON.stringify([...h.store.renders.values()])).not.toContain("base64");

    const me = await h.call("GET", "/v1/me", { headers: { [HEADER_INSTALL_TOKEN]: t.token } });
    expect(((await me.json()) as { free_renders_left: number }).free_renders_left).toBe(2);
  });

  it("only lets the owning install read a render", async () => {
    const h = harness();
    const a = await h.install();
    const b = await h.install();
    const job = await json(await h.render(a.token));
    const res = await h.get(b.token, job.id);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect((await h.get(a.token, "does-not-exist")).status).toBe(404);
  });

  it("records feedback only for completed renders", async () => {
    const h = harness();
    const t = await h.install();
    const job = await json(await h.render(t.token));
    const fb = (accepted: unknown) =>
      h.call("POST", `/v1/renders/${job.id}/feedback`, { body: { accepted }, headers: { [HEADER_INSTALL_TOKEN]: t.token } });

    const early = await fb(true);
    expect(early.status).toBe(409);

    await h.get(t.token, job.id);
    await h.get(t.token, job.id);
    expect((await fb("yes")).status).toBe(400);
    const ok = await fb(true);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: job.id, accepted: true });
    expect(h.store.renders.get(job.id)?.accepted).toBe(1);
  });
});

describe("idempotency", () => {
  it("returns the existing job for a repeated key and charges once", async () => {
    const h = harness();
    const t = await h.install();
    const first = await h.render(t.token, body(), { key: "same-key" });
    expect(first.status).toBe(202);
    const again = await h.render(t.token, body(), { key: "same-key" });
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const a = await json(first);
    const b = await json(again);
    expect(b.id).toBe(a.id);
    expect(h.store.renders.size).toBe(1);
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(2);
  });

  it("scopes keys per install", async () => {
    const h = harness();
    const a = await h.install();
    const b = await h.install();
    const ja = await json(await h.render(a.token, body(), { key: "k" }));
    const jb = await json(await h.render(b.token, body(), { key: "k" }));
    expect(ja.id).not.toBe(jb.id);
  });
});

describe("per-IP daily limit", () => {
  it("refuses after IP_DAILY_LIMIT renders from one IP and allows other IPs", async () => {
    const h = harness({ env: { IP_DAILY_LIMIT: "2", FREE_RENDERS_PER_INSTALL: "10" } });
    const t = await h.install();
    expect((await h.render(t.token, body(), { ip: "198.51.100.1" })).status).toBe(202);
    expect((await h.render(t.token, body(), { ip: "198.51.100.1" })).status).toBe(202);
    const third = await h.render(t.token, body(), { ip: "198.51.100.1" });
    expect(third.status).toBe(429);
    expect(await errorCode(third)).toBe("rate_limited");
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The refused request did not use quota.
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(8);
    expect((await h.render(t.token, body(), { ip: "198.51.100.2" })).status).toBe(202);
    // Raw IPs are never stored.
    expect([...h.store.ipDaily.keys()].join()).not.toContain("198.51.100");
  });

  it("gives the IP slot back when the install quota refuses the render", async () => {
    const h = harness({ env: { IP_DAILY_LIMIT: "1", FREE_RENDERS_PER_INSTALL: "0" } });
    const t = await h.install();
    expect((await h.render(t.token)).status).toBe(402);
    expect([...h.store.ipDaily.values()]).toEqual([0]);
  });
});

describe("install quota", () => {
  it("returns 402 quota_exhausted after the free renders", async () => {
    const h = harness();
    const t = await h.install();
    for (let i = 0; i < 3; i++) expect((await h.render(t.token)).status).toBe(202);
    const res = await h.render(t.token);
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe("quota_exhausted");
  });

  it("refunds the free render on provider_error but not on pose_not_found", async () => {
    const h = harness();
    const t = await h.install();
    const left = async () => (await h.store.getInstall(t.install_id))!.free_renders_left;

    const failing = await json(await h.render(t.token, body({ client_ref: "mock:fail" })));
    expect(await left()).toBe(2);
    await h.get(t.token, failing.id);
    const failed = await json(await h.get(t.token, failing.id));
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("provider_error");
    expect(await left()).toBe(3);
    // Polling a failed job again does not refund twice.
    await h.get(t.token, failing.id);
    expect(await left()).toBe(3);

    const pose = await json(await h.render(t.token, body({ client_ref: "mock:pose" })));
    await h.get(t.token, pose.id);
    const posed = await json(await h.get(t.token, pose.id));
    expect(posed.error?.code).toBe("pose_not_found");
    expect(await left()).toBe(2);
  });

  it("refunds quota and IP when the provider fails to start", async () => {
    const h = harness();
    const t = await h.install();
    const res = await h.render(t.token, body({ client_ref: "mock:start-fail" }));
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe("provider_error");
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(3);
    expect([...h.store.ipDaily.values()]).toEqual([0]);
    expect(h.store.renders.size).toBe(0);
  });
});

describe("spend breaker", () => {
  const day = () => utcDay(Date.now());

  it("reserves per render, refuses with 503 when the budget would be exceeded", async () => {
    const h = harness({ env: { PROVIDER: "paid", DAILY_BUDGET_USD: "0.2", FREE_RENDERS_PER_INSTALL: "10" } });
    const t = await h.install();
    expect((await h.render(t.token)).status).toBe(202);
    expect((await h.render(t.token)).status).toBe(202);
    expect((await h.store.getSpend(day(), "paid")).reserved_usd).toBeCloseTo(0.15);

    const refused = await h.render(t.token);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("budget_exhausted");
    // Quota refunded for the refused render: 10 - 2.
    expect((await h.store.getInstall(t.install_id))?.free_renders_left).toBe(8);
    expect((await h.store.getSpend(day(), "paid")).reserved_usd).toBeCloseTo(0.15);
  });

  it("converts reserved to spent on completion and releases on failure", async () => {
    const h = harness({ env: { PROVIDER: "paid", DAILY_BUDGET_USD: "0.2", FREE_RENDERS_PER_INSTALL: "10" } });
    const t = await h.install();
    const ok = await json(await h.render(t.token));
    const bad = await json(await h.render(t.token, body({ client_ref: "mock:fail" })));

    await h.get(t.token, ok.id);
    await h.get(t.token, ok.id);
    let spend = await h.store.getSpend(day(), "paid");
    expect(spend.spent_usd).toBeCloseTo(0.075);
    expect(spend.reserved_usd).toBeCloseTo(0.075);
    // Re-polling a completed job never books the cost twice.
    await h.get(t.token, ok.id);
    expect((await h.store.getSpend(day(), "paid")).spent_usd).toBeCloseTo(0.075);

    await h.get(t.token, bad.id);
    await h.get(t.token, bad.id);
    spend = await h.store.getSpend(day(), "paid");
    expect(spend.reserved_usd).toBeCloseTo(0);
    expect(spend.spent_usd).toBeCloseTo(0.075);
    expect(h.store.renders.get(bad.id)?.cost_usd).toBe(0);

    // Released budget is usable again: 0.075 spent + 0.075 new <= 0.2.
    expect((await h.render(t.token)).status).toBe(202);

    const health = await h.call("GET", "/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      provider: "paid",
      budget: { day: day(), spent: 0.075, reserved: 0.075, limit: 0.2 },
    });
  });

  it("releases the reservation when the provider fails to start", async () => {
    const h = harness({ env: { PROVIDER: "paid", DAILY_BUDGET_USD: "1" } });
    const t = await h.install();
    expect((await h.render(t.token, body({ client_ref: "mock:start-fail" }))).status).toBe(502);
    expect((await h.store.getSpend(day(), "paid")).reserved_usd).toBe(0);
  });
});

describe("health", () => {
  it("reports the provider and budget", async () => {
    const h = harness();
    const res = await h.call("GET", "/v1/health");
    const j = (await res.json()) as { ok: boolean; provider: string; budget: { limit: number; spent: number } };
    expect(j).toMatchObject({ ok: true, provider: "mock", budget: { limit: 5, spent: 0 } });
  });
});

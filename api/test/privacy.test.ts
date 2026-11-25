import type { RenderJob } from "@tryon/shared";
import { describe, expect, it } from "vitest";
import { purgeCutoffs, purgeOld, RETENTION_DAYS } from "../src/retention";
import { MemoryStore } from "../src/store/memory";
import type { RenderRow } from "../src/store/types";
import { harness } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 3, 17);

function render(id: string, installId: string, createdAt: number): RenderRow {
  return {
    id, install_id: installId, idempotency_key: id, provider: "mock", provider_job_id: null, status: "completed",
    category: "tops", site_origin: null, client_ref: null, cost_usd: 0, error_code: null, error_message: null,
    accepted: null, created_at: createdAt, completed_at: createdAt, ms: 1, account_id: null,
  };
}

describe("DELETE /v1/me", () => {
  it("removes the install and its ledger rows, and the token stops working", async () => {
    const h = harness();
    const { token, install_id } = await h.install();
    const other = await h.install();
    const job = (await (await h.render(token)).json()) as RenderJob;
    await h.render(other.token);
    expect(h.store.renders.size).toBe(2);

    const res = await h.call("DELETE", "/v1/me", { headers: { "X-Install-Token": token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.store.installs.has(install_id)).toBe(false);
    expect([...h.store.renders.values()].map((r) => r.install_id)).toEqual([other.install_id]);
    expect((await h.get(token, job.id)).status).toBe(401);
    expect((await h.call("GET", "/v1/me", { headers: { "X-Install-Token": token } })).status).toBe(401);
  });

  it("needs a token, and CORS preflight allows DELETE", async () => {
    const h = harness();
    expect((await h.call("DELETE", "/v1/me")).status).toBe(401);
    const pre = await h.call("OPTIONS", "/v1/me", { headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Method": "DELETE" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
  });
});

describe("retention", () => {
  it("computes the published cutoffs", () => {
    expect(RETENTION_DAYS).toEqual({ renders: 90, ipCounters: 2, installs: 365, accountMonths: 13, accounts: 365 });
    const c = purgeCutoffs(NOW);
    expect(c.rendersBefore).toBe(NOW - 90 * DAY);
    expect(c.ipDayBefore).toBe("2026-11-23");
    expect(c.installsBefore).toBe(NOW - 365 * DAY);
  });

  it("deletes old renders, old IP counters and old installs without renders", async () => {
    const store = new MemoryStore();
    await store.createInstall({ id: "old-idle", created_at: NOW - 400 * DAY, free_renders_left: 0 });
    await store.createInstall({ id: "old-active", created_at: NOW - 400 * DAY, free_renders_left: 1 });
    await store.createInstall({ id: "new", created_at: NOW - 5 * DAY, free_renders_left: 3 });
    await store.insertRender(render("r-old", "old-idle", NOW - 120 * DAY));
    await store.insertRender(render("r-recent", "old-active", NOW - 10 * DAY));
    await store.insertRender(render("r-new", "new", NOW - 1 * DAY));
    for (const day of ["2026-11-20", "2026-11-22", "2026-11-23", "2026-11-25"]) await store.hitIpDaily(day, "h", 20);

    const counts = await purgeOld(store, NOW);
    expect(counts).toEqual({ renders: 1, ipDays: 2, installs: 1, accountMonths: 0, accounts: 0 });
    expect([...store.renders.keys()].sort()).toEqual(["r-new", "r-recent"]);
    expect([...store.installs.keys()].sort()).toEqual(["new", "old-active"]);
    expect([...store.ipDaily.keys()].sort()).toEqual(["2026-11-23|h", "2026-11-25|h"]);
  });
});

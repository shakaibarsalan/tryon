// In-memory Store for tests and quick experiments. Same semantics as D1Store.
import { USD_EPSILON, type InstallRow, type RenderPatch, type RenderRow, type SpendRow, type Store } from "./types";

export class MemoryStore implements Store {
  readonly installs = new Map<string, InstallRow>();
  readonly renders = new Map<string, RenderRow>();
  readonly spend = new Map<string, SpendRow>();
  readonly ipDaily = new Map<string, number>();

  async createInstall(row: InstallRow): Promise<void> {
    this.installs.set(row.id, { ...row });
  }

  async getInstall(id: string): Promise<InstallRow | null> {
    const row = this.installs.get(id);
    return row ? { ...row } : null;
  }

  async consumeFreeRender(installId: string): Promise<boolean> {
    const row = this.installs.get(installId);
    if (!row || row.free_renders_left <= 0) return false;
    row.free_renders_left -= 1;
    return true;
  }

  async refundFreeRender(installId: string): Promise<void> {
    const row = this.installs.get(installId);
    if (row) row.free_renders_left += 1;
  }

  async getRender(id: string): Promise<RenderRow | null> {
    const row = this.renders.get(id);
    return row ? { ...row } : null;
  }

  async getRenderByIdempotencyKey(installId: string, key: string): Promise<RenderRow | null> {
    for (const row of this.renders.values()) {
      if (row.install_id === installId && row.idempotency_key === key) return { ...row };
    }
    return null;
  }

  async insertRender(row: RenderRow): Promise<{ inserted: true } | { inserted: false; existing: RenderRow }> {
    const existing = await this.getRenderByIdempotencyKey(row.install_id, row.idempotency_key);
    if (existing) return { inserted: false, existing };
    this.renders.set(row.id, { ...row });
    return { inserted: true };
  }

  async updateRender(id: string, patch: RenderPatch): Promise<void> {
    const row = this.renders.get(id);
    if (row) Object.assign(row, patch);
  }

  async finishRender(id: string, patch: RenderPatch & { status: "completed" | "failed" }): Promise<boolean> {
    const row = this.renders.get(id);
    if (!row || (row.status !== "queued" && row.status !== "processing")) return false;
    Object.assign(row, patch);
    return true;
  }

  async setAccepted(id: string, accepted: boolean): Promise<void> {
    const row = this.renders.get(id);
    if (row) row.accepted = accepted ? 1 : 0;
  }

  async hitIpDaily(day: string, ipHash: string, limit: number): Promise<boolean> {
    const key = `${day}|${ipHash}`;
    const count = this.ipDaily.get(key) ?? 0;
    if (count >= limit) return false;
    this.ipDaily.set(key, count + 1);
    return true;
  }

  async releaseIpDaily(day: string, ipHash: string): Promise<void> {
    const key = `${day}|${ipHash}`;
    const count = this.ipDaily.get(key) ?? 0;
    if (count > 0) this.ipDaily.set(key, count - 1);
  }

  private spendRow(day: string, provider: string): SpendRow {
    const key = `${day}|${provider}`;
    let row = this.spend.get(key);
    if (!row) {
      row = { day, provider, reserved_usd: 0, spent_usd: 0 };
      this.spend.set(key, row);
    }
    return row;
  }

  async getSpend(day: string, provider: string): Promise<SpendRow> {
    return { ...this.spendRow(day, provider) };
  }

  async reserveSpend(day: string, provider: string, amount: number, budget: number): Promise<boolean> {
    const row = this.spendRow(day, provider);
    if (row.reserved_usd + row.spent_usd + amount > budget + USD_EPSILON) return false;
    row.reserved_usd += amount;
    return true;
  }

  async releaseSpend(day: string, provider: string, amount: number): Promise<void> {
    const row = this.spendRow(day, provider);
    row.reserved_usd = Math.max(0, row.reserved_usd - amount);
  }

  async convertSpend(day: string, provider: string, reserved: number, actual: number): Promise<void> {
    const row = this.spendRow(day, provider);
    row.reserved_usd = Math.max(0, row.reserved_usd - reserved);
    row.spent_usd += actual;
  }
}

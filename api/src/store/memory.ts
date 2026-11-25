// In-memory Store for tests and quick experiments. Same semantics as D1Store.
import {
  USD_EPSILON,
  type AccountRow,
  type InstallRow,
  type PurgeCounts,
  type PurgeCutoffs,
  type RenderPatch,
  type RenderRow,
  type SpendRow,
  type Store,
} from "./types";

export class MemoryStore implements Store {
  readonly installs = new Map<string, InstallRow>();
  readonly renders = new Map<string, RenderRow>();
  readonly spend = new Map<string, SpendRow>();
  readonly ipDaily = new Map<string, number>();
  readonly accounts = new Map<string, AccountRow>();
  /** "accountId|month" -> renders used. */
  readonly accountUsage = new Map<string, number>();

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

  async deleteInstall(installId: string): Promise<void> {
    for (const [id, row] of this.renders) if (row.install_id === installId) this.renders.delete(id);
    this.installs.delete(installId);
  }

  async purge(c: PurgeCutoffs): Promise<PurgeCounts> {
    const counts: PurgeCounts = { renders: 0, ipDays: 0, installs: 0, accountMonths: 0, accounts: 0 };
    for (const [id, row] of this.renders) {
      if (row.created_at < c.rendersBefore) {
        this.renders.delete(id);
        counts.renders++;
      }
    }
    for (const key of [...this.ipDaily.keys()]) {
      if (key.split("|")[0]! < c.ipDayBefore) {
        this.ipDaily.delete(key);
        counts.ipDays++;
      }
    }
    const withRenders = new Set([...this.renders.values()].map((r) => r.install_id));
    for (const [id, row] of this.installs) {
      if (row.created_at < c.installsBefore && !withRenders.has(id)) {
        this.installs.delete(id);
        counts.installs++;
      }
    }
    for (const key of [...this.accountUsage.keys()]) {
      if (key.split("|")[1]! < c.usageMonthBefore) {
        this.accountUsage.delete(key);
        counts.accountMonths++;
      }
    }
    const withUsage = new Set([...this.accountUsage.keys()].map((k) => k.split("|")[0]));
    for (const [id, row] of this.accounts) {
      if (row.created_at < c.accountsBefore && !withUsage.has(id)) {
        this.accounts.delete(id);
        counts.accounts++;
      }
    }
    return counts;
  }

  async getOrCreateAccount(row: AccountRow): Promise<AccountRow> {
    for (const a of this.accounts.values()) if (a.subject_hash === row.subject_hash) return { ...a };
    this.accounts.set(row.id, { ...row });
    return { ...row };
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    const row = this.accounts.get(id);
    return row ? { ...row } : null;
  }

  async consumeAccountRender(accountId: string, month: string, limit: number): Promise<boolean> {
    const key = `${accountId}|${month}`;
    const used = this.accountUsage.get(key) ?? 0;
    if (used >= limit) return false;
    this.accountUsage.set(key, used + 1);
    return true;
  }

  async refundAccountRender(accountId: string, month: string): Promise<void> {
    const key = `${accountId}|${month}`;
    const used = this.accountUsage.get(key) ?? 0;
    if (used > 0) this.accountUsage.set(key, used - 1);
  }

  async accountRendersUsed(accountId: string, month: string): Promise<number> {
    return this.accountUsage.get(`${accountId}|${month}`) ?? 0;
  }

  async deleteAccount(accountId: string): Promise<void> {
    for (const [id, row] of this.renders) if (row.account_id === accountId) this.renders.delete(id);
    for (const key of [...this.accountUsage.keys()]) if (key.startsWith(`${accountId}|`)) this.accountUsage.delete(key);
    this.accounts.delete(accountId);
  }
}

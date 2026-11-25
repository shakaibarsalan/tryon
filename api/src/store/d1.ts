// D1-backed Store. Each guard is one conditional statement, which D1 executes atomically.
// Planned for phase 1: move the daily spend counters to a Durable Object.
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

const PATCH_COLUMNS = ["status", "provider_job_id", "cost_usd", "error_code", "error_message", "completed_at", "ms"] as const;

function patchSql(patch: RenderPatch): { sets: string; values: unknown[] } {
  const cols = PATCH_COLUMNS.filter((c) => patch[c] !== undefined);
  return { sets: cols.map((c) => `${c} = ?`).join(", "), values: cols.map((c) => patch[c]) };
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async createInstall(row: InstallRow): Promise<void> {
    await this.db
      .prepare("INSERT INTO installs (id, created_at, free_renders_left) VALUES (?, ?, ?)")
      .bind(row.id, row.created_at, row.free_renders_left)
      .run();
  }

  async getInstall(id: string): Promise<InstallRow | null> {
    return this.db.prepare("SELECT id, created_at, free_renders_left FROM installs WHERE id = ?").bind(id).first<InstallRow>();
  }

  async consumeFreeRender(installId: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE installs SET free_renders_left = free_renders_left - 1 WHERE id = ? AND free_renders_left > 0")
      .bind(installId)
      .run();
    return r.meta.changes === 1;
  }

  async refundFreeRender(installId: string): Promise<void> {
    await this.db.prepare("UPDATE installs SET free_renders_left = free_renders_left + 1 WHERE id = ?").bind(installId).run();
  }

  async getRender(id: string): Promise<RenderRow | null> {
    return this.db.prepare("SELECT * FROM renders WHERE id = ?").bind(id).first<RenderRow>();
  }

  async getRenderByIdempotencyKey(installId: string, key: string): Promise<RenderRow | null> {
    return this.db
      .prepare("SELECT * FROM renders WHERE install_id = ? AND idempotency_key = ?")
      .bind(installId, key)
      .first<RenderRow>();
  }

  async insertRender(row: RenderRow): Promise<{ inserted: true } | { inserted: false; existing: RenderRow }> {
    const r = await this.db
      .prepare(
        `INSERT INTO renders (id, install_id, idempotency_key, provider, provider_job_id, status, category, site_origin,
           client_ref, cost_usd, error_code, error_message, accepted, created_at, completed_at, ms, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (install_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        row.id, row.install_id, row.idempotency_key, row.provider, row.provider_job_id, row.status, row.category,
        row.site_origin, row.client_ref, row.cost_usd, row.error_code, row.error_message, row.accepted, row.created_at,
        row.completed_at, row.ms, row.account_id,
      )
      .run();
    if (r.meta.changes === 1) return { inserted: true };
    const existing = await this.getRenderByIdempotencyKey(row.install_id, row.idempotency_key);
    if (!existing) throw new Error("render insert conflicted but no existing row was found");
    return { inserted: false, existing };
  }

  async updateRender(id: string, patch: RenderPatch): Promise<void> {
    const { sets, values } = patchSql(patch);
    if (!sets) return;
    await this.db.prepare(`UPDATE renders SET ${sets} WHERE id = ?`).bind(...values, id).run();
  }

  async finishRender(id: string, patch: RenderPatch & { status: "completed" | "failed" }): Promise<boolean> {
    const { sets, values } = patchSql(patch);
    const r = await this.db
      .prepare(`UPDATE renders SET ${sets} WHERE id = ? AND status IN ('queued', 'processing')`)
      .bind(...values, id)
      .run();
    return r.meta.changes === 1;
  }

  async setAccepted(id: string, accepted: boolean): Promise<void> {
    await this.db.prepare("UPDATE renders SET accepted = ? WHERE id = ?").bind(accepted ? 1 : 0, id).run();
  }

  async hitIpDaily(day: string, ipHash: string, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const r = await this.db
      .prepare(
        `INSERT INTO ip_daily (day, ip_hash, count) VALUES (?1, ?2, 1)
         ON CONFLICT (day, ip_hash) DO UPDATE SET count = count + 1 WHERE count < ?3`,
      )
      .bind(day, ipHash, limit)
      .run();
    return r.meta.changes === 1;
  }

  async releaseIpDaily(day: string, ipHash: string): Promise<void> {
    await this.db
      .prepare("UPDATE ip_daily SET count = count - 1 WHERE day = ? AND ip_hash = ? AND count > 0")
      .bind(day, ipHash)
      .run();
  }

  private async ensureSpendRow(day: string, provider: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO spend_daily (day, provider, reserved_usd, spent_usd) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING")
      .bind(day, provider)
      .run();
  }

  async getSpend(day: string, provider: string): Promise<SpendRow> {
    const row = await this.db
      .prepare("SELECT day, provider, reserved_usd, spent_usd FROM spend_daily WHERE day = ? AND provider = ?")
      .bind(day, provider)
      .first<SpendRow>();
    return row ?? { day, provider, reserved_usd: 0, spent_usd: 0 };
  }

  async reserveSpend(day: string, provider: string, amount: number, budget: number): Promise<boolean> {
    await this.ensureSpendRow(day, provider);
    const r = await this.db
      .prepare(
        `UPDATE spend_daily SET reserved_usd = reserved_usd + ?3
         WHERE day = ?1 AND provider = ?2 AND reserved_usd + spent_usd + ?3 <= ?4`,
      )
      .bind(day, provider, amount, budget + USD_EPSILON)
      .run();
    return r.meta.changes === 1;
  }

  async releaseSpend(day: string, provider: string, amount: number): Promise<void> {
    await this.db
      .prepare("UPDATE spend_daily SET reserved_usd = MAX(0, reserved_usd - ?3) WHERE day = ?1 AND provider = ?2")
      .bind(day, provider, amount)
      .run();
  }

  async convertSpend(day: string, provider: string, reserved: number, actual: number): Promise<void> {
    await this.ensureSpendRow(day, provider);
    await this.db
      .prepare(
        `UPDATE spend_daily SET reserved_usd = MAX(0, reserved_usd - ?3), spent_usd = spent_usd + ?4
         WHERE day = ?1 AND provider = ?2`,
      )
      .bind(day, provider, reserved, actual)
      .run();
  }

  async deleteInstall(installId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM renders WHERE install_id = ?").bind(installId),
      this.db.prepare("DELETE FROM installs WHERE id = ?").bind(installId),
    ]);
  }

  async purge(c: PurgeCutoffs): Promise<PurgeCounts> {
    const [renders, ipDays, installs, accountMonths, accounts] = await this.db.batch([
      this.db.prepare("DELETE FROM renders WHERE created_at < ?").bind(c.rendersBefore),
      this.db.prepare("DELETE FROM ip_daily WHERE day < ?").bind(c.ipDayBefore),
      this.db
        .prepare("DELETE FROM installs WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM renders r WHERE r.install_id = installs.id)")
        .bind(c.installsBefore),
      this.db.prepare("DELETE FROM account_usage WHERE month < ?").bind(c.usageMonthBefore),
      this.db
        .prepare(
          "DELETE FROM accounts WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM account_usage u WHERE u.account_id = accounts.id)",
        )
        .bind(c.accountsBefore),
    ]);
    const n = (r: D1Result | undefined) => r?.meta.changes ?? 0;
    return { renders: n(renders), ipDays: n(ipDays), installs: n(installs), accountMonths: n(accountMonths), accounts: n(accounts) };
  }

  async getOrCreateAccount(row: AccountRow): Promise<AccountRow> {
    await this.db
      .prepare("INSERT INTO accounts (id, subject_hash, created_at) VALUES (?, ?, ?) ON CONFLICT (subject_hash) DO NOTHING")
      .bind(row.id, row.subject_hash, row.created_at)
      .run();
    const found = await this.db
      .prepare("SELECT id, subject_hash, created_at FROM accounts WHERE subject_hash = ?")
      .bind(row.subject_hash)
      .first<AccountRow>();
    if (!found) throw new Error("account insert failed");
    return found;
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    return this.db.prepare("SELECT id, subject_hash, created_at FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
  }

  async consumeAccountRender(accountId: string, month: string, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    const r = await this.db
      .prepare(
        `INSERT INTO account_usage (account_id, month, renders) VALUES (?1, ?2, 1)
         ON CONFLICT (account_id, month) DO UPDATE SET renders = renders + 1 WHERE renders < ?3`,
      )
      .bind(accountId, month, limit)
      .run();
    return r.meta.changes === 1;
  }

  async refundAccountRender(accountId: string, month: string): Promise<void> {
    await this.db
      .prepare("UPDATE account_usage SET renders = renders - 1 WHERE account_id = ? AND month = ? AND renders > 0")
      .bind(accountId, month)
      .run();
  }

  async accountRendersUsed(accountId: string, month: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT renders FROM account_usage WHERE account_id = ? AND month = ?")
      .bind(accountId, month)
      .first<{ renders: number }>();
    return row?.renders ?? 0;
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM renders WHERE account_id = ?").bind(accountId),
      this.db.prepare("DELETE FROM account_usage WHERE account_id = ?").bind(accountId),
      this.db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
    ]);
  }
}

// Retention schedule (published in docs/legal/privacy.md). Run nightly by the Worker's cron trigger.
import type { PurgeCounts, PurgeCutoffs, Store } from "./store/types";
import { utcDay, utcMonth } from "./util";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DAYS = {
  /** Ledger rows for single try-ons. */
  renders: 90,
  /** Per-network daily counters (keyed IP hashes). */
  ipCounters: 2,
  /** Install records, once they also have no try-ons left in the ledger. */
  installs: 365,
  /** Signed-in accounts' monthly counts, in months. */
  accountMonths: 13,
  /** Accounts, once they also have no monthly counts left. */
  accounts: 365,
} as const;

/** The UTC month `n` months before the one `nowMs` is in, e.g. ("2026-11", 13) -> "2025-10". */
export function monthsBefore(nowMs: number, n: number): string {
  const d = new Date(nowMs);
  return utcMonth(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
}

export function purgeCutoffs(nowMs: number): PurgeCutoffs {
  return {
    rendersBefore: nowMs - RETENTION_DAYS.renders * DAY_MS,
    ipDayBefore: utcDay(nowMs - RETENTION_DAYS.ipCounters * DAY_MS),
    installsBefore: nowMs - RETENTION_DAYS.installs * DAY_MS,
    usageMonthBefore: monthsBefore(nowMs, RETENTION_DAYS.accountMonths),
    accountsBefore: nowMs - RETENTION_DAYS.accounts * DAY_MS,
  };
}

export async function purgeOld(store: Store, nowMs: number): Promise<PurgeCounts> {
  const counts = await store.purge(purgeCutoffs(nowMs));
  console.log(
    `[retention] deleted ${counts.renders} renders, ${counts.ipDays} IP counters, ${counts.installs} installs, ` +
      `${counts.accountMonths} account months, ${counts.accounts} accounts`,
  );
  return counts;
}

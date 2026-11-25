import type { RenderStatus } from "@tryon/shared";

export interface AccountRow {
  id: string;
  /** HMAC of the identity provider's account id. */
  subject_hash: string;
  created_at: number;
}

export interface InstallRow {
  id: string;
  created_at: number;
  free_renders_left: number;
}

/** One render in the ledger. Never holds image data. */
export interface RenderRow {
  id: string;
  install_id: string;
  idempotency_key: string;
  provider: string;
  provider_job_id: string | null;
  status: RenderStatus;
  category: string;
  site_origin: string | null;
  client_ref: string | null;
  cost_usd: number;
  error_code: string | null;
  error_message: string | null;
  accepted: number | null;
  created_at: number;
  completed_at: number | null;
  ms: number | null;
  /** Set when the render used this account's monthly quota (not the install's free renders). */
  account_id: string | null;
}

export type RenderPatch = Partial<
  Pick<RenderRow, "status" | "provider_job_id" | "cost_usd" | "error_code" | "error_message" | "completed_at" | "ms">
>;

export interface SpendRow {
  day: string;
  provider: string;
  reserved_usd: number;
  spent_usd: number;
}

/**
 * Persistence used by the app. Every method that guards money or quota is a single atomic
 * conditional write, so concurrent requests cannot overspend (D1 runs each statement atomically).
 */
export interface Store {
  createInstall(row: InstallRow): Promise<void>;
  getInstall(id: string): Promise<InstallRow | null>;
  /** Decrements free_renders_left when > 0. Returns false when none are left. */
  consumeFreeRender(installId: string): Promise<boolean>;
  refundFreeRender(installId: string): Promise<void>;

  getRender(id: string): Promise<RenderRow | null>;
  getRenderByIdempotencyKey(installId: string, key: string): Promise<RenderRow | null>;
  /** Inserts unless (install_id, idempotency_key) exists; then returns the existing row instead. */
  insertRender(row: RenderRow): Promise<{ inserted: true } | { inserted: false; existing: RenderRow }>;
  updateRender(id: string, patch: RenderPatch): Promise<void>;
  /** Applies the patch only while the render is still queued/processing. Returns true if it did. */
  finishRender(id: string, patch: RenderPatch & { status: "completed" | "failed" }): Promise<boolean>;
  setAccepted(id: string, accepted: boolean): Promise<void>;

  /** Increments the IP counter if it is below `limit`. Returns false when the limit is reached. */
  hitIpDaily(day: string, ipHash: string, limit: number): Promise<boolean>;
  releaseIpDaily(day: string, ipHash: string): Promise<void>;

  getSpend(day: string, provider: string): Promise<SpendRow>;
  /** Adds `amount` to reserved if reserved + spent + amount <= budget. Returns false otherwise. */
  reserveSpend(day: string, provider: string, amount: number, budget: number): Promise<boolean>;
  releaseSpend(day: string, provider: string, amount: number): Promise<void>;
  /** Moves `reserved` out of the reservation and books `actual` as spent. */
  convertSpend(day: string, provider: string, reserved: number, actual: number): Promise<void>;

  /** Deletes an install and all its renders ("Delete all my data"). */
  deleteInstall(installId: string): Promise<void>;

  /** The account for this subject hash, created with `row` if it doesn't exist yet. */
  getOrCreateAccount(row: AccountRow): Promise<AccountRow>;
  getAccount(id: string): Promise<AccountRow | null>;
  /** Counts one render for the month if fewer than `limit` were used. Returns false otherwise. */
  consumeAccountRender(accountId: string, month: string, limit: number): Promise<boolean>;
  refundAccountRender(accountId: string, month: string): Promise<void>;
  accountRendersUsed(accountId: string, month: string): Promise<number>;
  /** Deletes an account, its usage and the renders it paid for. */
  deleteAccount(accountId: string): Promise<void>;
  /**
   * Retention cleanup: renders created before `rendersBefore`, IP counters for days before
   * `ipDayBefore`, installs created before `installsBefore` that have no renders left, account
   * usage before `usageMonthBefore`, and accounts created before `accountsBefore` with no usage.
   */
  purge(cutoffs: PurgeCutoffs): Promise<PurgeCounts>;
}

export interface PurgeCutoffs {
  rendersBefore: number;
  ipDayBefore: string;
  installsBefore: number;
  /** Account usage rows for months before this one ("2025-11"). */
  usageMonthBefore: string;
  /** Accounts created before this time with no usage rows left. */
  accountsBefore: number;
}

export interface PurgeCounts {
  renders: number;
  ipDays: number;
  installs: number;
  accountMonths: number;
  accounts: number;
}

/** Tolerance for float comparisons on USD amounts. */
export const USD_EPSILON = 1e-9;

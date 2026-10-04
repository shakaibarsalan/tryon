import type { RenderStatus } from "@tryon/shared";

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
}

/** Tolerance for float comparisons on USD amounts. */
export const USD_EPSILON = 1e-9;

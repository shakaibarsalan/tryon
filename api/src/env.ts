import { LIMITS } from "@tryon/shared";

/** Worker bindings: [vars] from wrangler.toml plus secrets. */
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  PROVIDER?: string;
  DAILY_BUDGET_USD?: string;
  FREE_RENDERS_PER_INSTALL?: string;
  IP_DAILY_LIMIT?: string;
  FASHN_MODE?: string;
  ALLOWED_ORIGINS?: string;
  /** Optional hf-space override of the Space's num_timesteps (default 50). */
  HF_NUM_TIMESTEPS?: string;
  // Secrets
  FASHN_API_KEY?: string;
  HF_TOKEN?: string;
  INSTALL_TOKEN_SECRET?: string;
}

export interface Config {
  production: boolean;
  provider: string;
  dailyBudgetUsd: number;
  freeRendersPerInstall: number;
  ipDailyLimit: number;
  allowedOrigins: string[];
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function isProduction(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}

export function readConfig(env: Env): Config {
  return {
    production: isProduction(env),
    provider: (env.PROVIDER ?? "mock").trim() || "mock",
    dailyBudgetUsd: num(env.DAILY_BUDGET_USD, 5),
    freeRendersPerInstall: Math.floor(num(env.FREE_RENDERS_PER_INSTALL, LIMITS.freeRendersPerInstall)),
    ipDailyLimit: Math.floor(num(env.IP_DAILY_LIMIT, 20)),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

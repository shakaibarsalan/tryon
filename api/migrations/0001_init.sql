-- Try-On API ledger. Images are never stored: no column holds image data or image URLs.
-- Timestamps are epoch milliseconds (UTC). Money is USD.

CREATE TABLE installs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  free_renders_left INTEGER NOT NULL CHECK (free_renders_left >= 0)
);

CREATE TABLE renders (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs(id),
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  category TEXT NOT NULL,
  site_origin TEXT,
  client_ref TEXT,
  -- Reserved estimate while running, actual cost when completed, 0 when failed.
  cost_usd REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  -- NULL until feedback: 1 accepted, 0 rejected.
  accepted INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  ms INTEGER,
  UNIQUE (install_id, idempotency_key)
);

CREATE INDEX renders_created_at ON renders(created_at);

-- Spend breaker counters per UTC day and provider.
CREATE TABLE spend_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  reserved_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

-- Per-IP daily render counter. ip_hash is an HMAC of (day, IP); raw IPs are never stored.
CREATE TABLE ip_daily (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip_hash)
);

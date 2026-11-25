-- Optional sign-in. Only a keyed hash of the Google account id is stored: no email, no name.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Renders used per account per calendar month (UTC), e.g. month = '2026-11'.
CREATE TABLE account_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  month TEXT NOT NULL,
  renders INTEGER NOT NULL DEFAULT 0 CHECK (renders >= 0),
  PRIMARY KEY (account_id, month)
);

-- Set when a render used an account's monthly quota instead of the install's free renders.
ALTER TABLE renders ADD COLUMN account_id TEXT;

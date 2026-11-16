CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
  ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS email_action_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_action_tokens_lookup_idx
  ON email_action_tokens (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS rewards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  points_cost INTEGER NOT NULL CHECK (points_cost > 0),
  icon TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO rewards (id, name, points_cost, icon, active) VALUES
  ('coffee', 'A coffee on us', 100, '☕', TRUE),
  ('pastry', 'Your favorite pastry', 150, '🥐', TRUE),
  ('lunch', 'Lunch, with love', 250, '🥗', TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  points_cost = EXCLUDED.points_cost,
  active = EXCLUDED.active;

CREATE TABLE IF NOT EXISTS redemptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id TEXT NOT NULL REFERENCES rewards(id),
  idempotency_key TEXT NOT NULL,
  points_cost INTEGER NOT NULL CHECK (points_cost > 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('purchase_credit', 'admin_credit', 'redemption')),
  reference_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS points_ledger_user_id_idx ON points_ledger (user_id, created_at);

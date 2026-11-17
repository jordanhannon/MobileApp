ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE auth_provider_nonces (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  nonce_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (provider, nonce_hash)
);

CREATE INDEX auth_provider_nonces_expiry_idx
  ON auth_provider_nonces (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE user_auth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('member', 'staff', 'admin'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_actor_created_idx
  ON admin_audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_target_created_idx
  ON admin_audit_log (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  description TEXT NOT NULL,
  tag TEXT NOT NULL,
  icon TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  rsvp_open BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_rsvps_event_created_idx
  ON event_rsvps (event_id, created_at, user_id);

INSERT INTO events
  (id, title, starts_at, ends_at, description, tag, icon)
VALUES
  (
    'tasting', 'A taste of the season',
    '2026-11-14 11:00:00-05', '2026-11-14 13:00:00-05',
    'Meet our seasonal favorites with a tasting made for our members.',
    'MEMBER EXCLUSIVE', '🥐'
  ),
  (
    'coffee', 'Coffee & good company',
    '2026-11-21 09:00:00-05', '2026-11-21 11:00:00-05',
    'Discover your new favorite brew at a relaxed coffee workshop.',
    'COMMUNITY', '☕'
  ),
  (
    'supper', 'The neighborhood table',
    '2026-11-28 17:00:00-05', '2026-11-28 19:00:00-05',
    'Come together for a cozy evening of fresh food and friendly faces.',
    'IN STORE', '🥗'
  )
ON CONFLICT (id) DO NOTHING;

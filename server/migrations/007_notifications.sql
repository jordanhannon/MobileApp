CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rsvp_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  event_changes_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rewards_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  announcements_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_schedule TEXT NOT NULL DEFAULT '24h'
    CHECK (reminder_schedule IN ('off', '24h', '1h', '24h_1h')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_push_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_push_tokens_user_active_idx
  ON notification_push_tokens (user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'rsvp_confirmed', 'rsvp_cancelled', 'event_reminder', 'event_changed',
    'event_cancelled', 'points_earned', 'reward_redeemed', 'announcement'
  )),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  data JSONB NOT NULL DEFAULT '{}'::JSONB,
  dedupe_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS notifications_user_feed_idx
  ON notifications (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_push_outbox (
  id UUID PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  push_token_id UUID NOT NULL REFERENCES notification_push_tokens(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'submitted', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  expo_ticket_id TEXT UNIQUE,
  receipt_check_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, push_token_id)
);

CREATE INDEX IF NOT EXISTS notification_push_outbox_due_idx
  ON notification_push_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS notification_push_outbox_receipts_idx
  ON notification_push_outbox (receipt_check_at)
  WHERE status = 'submitted';

CREATE TABLE IF NOT EXISTS staff_announcements (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION notify_points_award() RETURNS TRIGGER AS $$
DECLARE
  created_notification_id UUID;
BEGIN
  IF NEW.delta <= 0 OR NEW.entry_type NOT IN ('purchase_credit', 'admin_credit') THEN
    RETURN NEW;
  END IF;

  IF NOT COALESCE((
    SELECT rewards_enabled FROM notification_preferences WHERE user_id = NEW.user_id
  ), TRUE) THEN
    RETURN NEW;
  END IF;

  INSERT INTO notifications (
    id, user_id, notification_type, title, body, data, dedupe_key
  )
  VALUES (
    gen_random_uuid(),
    NEW.user_id,
    'points_earned',
    'Points added',
    NEW.delta::TEXT || CASE WHEN NEW.delta = 1 THEN ' reward point was added to your balance.'
                            ELSE ' reward points were added to your balance.' END,
    jsonb_build_object('delta', NEW.delta),
    'points-earned:' || NEW.id::TEXT
  )
  ON CONFLICT (user_id, dedupe_key) DO NOTHING
  RETURNING id INTO created_notification_id;

  IF created_notification_id IS NOT NULL AND COALESCE((
    SELECT push_enabled FROM notification_preferences WHERE user_id = NEW.user_id
  ), TRUE) THEN
    INSERT INTO notification_push_outbox (id, notification_id, push_token_id)
    SELECT gen_random_uuid(), created_notification_id, token.id
    FROM notification_push_tokens token
    WHERE token.user_id = NEW.user_id AND token.revoked_at IS NULL
    ON CONFLICT (notification_id, push_token_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS points_award_notification_trigger ON points_ledger;
CREATE TRIGGER points_award_notification_trigger
  AFTER INSERT ON points_ledger
  FOR EACH ROW
  EXECUTE FUNCTION notify_points_award();

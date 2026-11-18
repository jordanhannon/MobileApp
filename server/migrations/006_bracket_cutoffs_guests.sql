ALTER TABLE events
  ADD COLUMN bracket_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE admin_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE tournament_brackets
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN draw_source TEXT NOT NULL DEFAULT 'staff'
    CHECK (draw_source IN ('staff', 'system'));

ALTER TABLE tournament_brackets
  DROP CONSTRAINT IF EXISTS tournament_brackets_champion_user_id_fkey;

ALTER TABLE tournament_brackets
  RENAME COLUMN champion_user_id TO champion_entrant_id;

ALTER TABLE tournament_bracket_entrants
  ADD COLUMN entrant_id UUID,
  ADD COLUMN display_name TEXT;

UPDATE tournament_bracket_entrants AS entrants
SET entrant_id = entrants.user_id,
    display_name = users.name
FROM users
WHERE users.id = entrants.user_id;

ALTER TABLE tournament_bracket_entrants
  DROP CONSTRAINT tournament_bracket_entrants_pkey;

ALTER TABLE tournament_bracket_entrants
  ALTER COLUMN entrant_id SET NOT NULL,
  ALTER COLUMN display_name SET NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL,
  ADD CONSTRAINT tournament_bracket_entrants_pkey PRIMARY KEY (entrant_id),
  ADD CONSTRAINT tournament_bracket_entrants_occurrence_entrant_unique
    UNIQUE (event_id, occurrence_start, entrant_id);

ALTER TABLE tournament_bracket_matches
  DROP CONSTRAINT IF EXISTS tournament_bracket_matches_player_one_id_fkey,
  DROP CONSTRAINT IF EXISTS tournament_bracket_matches_player_two_id_fkey,
  DROP CONSTRAINT IF EXISTS tournament_bracket_matches_winner_user_id_fkey;

DO $$
DECLARE
  check_constraint RECORD;
BEGIN
  FOR check_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'tournament_bracket_matches'::REGCLASS
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%winner_user_id%'
  LOOP
    EXECUTE FORMAT(
      'ALTER TABLE tournament_bracket_matches DROP CONSTRAINT %I',
      check_constraint.conname
    );
  END LOOP;
END
$$;

ALTER TABLE tournament_bracket_matches
  RENAME COLUMN player_one_id TO player_one_entrant_id;
ALTER TABLE tournament_bracket_matches
  RENAME COLUMN player_two_id TO player_two_entrant_id;
ALTER TABLE tournament_bracket_matches
  RENAME COLUMN winner_user_id TO winner_entrant_id;

ALTER TABLE tournament_bracket_matches
  ADD CONSTRAINT tournament_bracket_matches_player_one_entrant_fkey
    FOREIGN KEY (event_id, occurrence_start, player_one_entrant_id)
    REFERENCES tournament_bracket_entrants (event_id, occurrence_start, entrant_id),
  ADD CONSTRAINT tournament_bracket_matches_player_two_entrant_fkey
    FOREIGN KEY (event_id, occurrence_start, player_two_entrant_id)
    REFERENCES tournament_bracket_entrants (event_id, occurrence_start, entrant_id),
  ADD CONSTRAINT tournament_bracket_matches_winner_entrant_fkey
    FOREIGN KEY (event_id, occurrence_start, winner_entrant_id)
    REFERENCES tournament_bracket_entrants (event_id, occurrence_start, entrant_id),
  ADD CONSTRAINT tournament_bracket_matches_distinct_entrants_check
    CHECK (
      player_one_entrant_id IS NULL OR player_two_entrant_id IS NULL
      OR player_one_entrant_id <> player_two_entrant_id
    ),
  ADD CONSTRAINT tournament_bracket_matches_winner_is_player_check
    CHECK (
      winner_entrant_id IS NULL
      OR winner_entrant_id IN (player_one_entrant_id, player_two_entrant_id)
    );

ALTER TABLE tournament_brackets
  ADD CONSTRAINT tournament_brackets_champion_entrant_fkey
    FOREIGN KEY (event_id, occurrence_start, champion_entrant_id)
    REFERENCES tournament_bracket_entrants (event_id, occurrence_start, entrant_id);

CREATE UNIQUE INDEX tournament_bracket_entrants_user_unique
  ON tournament_bracket_entrants (event_id, occurrence_start, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE event_bracket_guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  occurrence_start TIMESTAMPTZ NOT NULL,
  name TEXT NOT NULL CHECK (LENGTH(BTRIM(name)) BETWEEN 1 AND 120),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX event_bracket_guests_occurrence_idx
  ON event_bracket_guests (event_id, occurrence_start, created_at, id);

CREATE INDEX events_bracket_enabled_idx
  ON events (starts_at, id)
  WHERE active = TRUE AND bracket_enabled = TRUE;

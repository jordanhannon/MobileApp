CREATE TABLE tournament_brackets (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  occurrence_start TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('drawn', 'completed')),
  randomized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  champion_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (event_id, occurrence_start)
);

CREATE TABLE tournament_bracket_entrants (
  event_id TEXT NOT NULL,
  occurrence_start TIMESTAMPTZ NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'waitlisted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, occurrence_start, user_id),
  FOREIGN KEY (event_id, occurrence_start)
    REFERENCES tournament_brackets(event_id, occurrence_start) ON DELETE CASCADE
);

CREATE TABLE tournament_bracket_matches (
  id UUID PRIMARY KEY,
  event_id TEXT NOT NULL,
  occurrence_start TIMESTAMPTZ NOT NULL,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  match_number INTEGER NOT NULL CHECK (match_number > 0),
  player_one_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  player_two_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  winner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  next_match_id UUID REFERENCES tournament_bracket_matches(id) ON DELETE CASCADE,
  next_slot TEXT CHECK (next_slot IS NULL OR next_slot IN ('one', 'two')),
  UNIQUE (event_id, occurrence_start, round_number, match_number),
  FOREIGN KEY (event_id, occurrence_start)
    REFERENCES tournament_brackets(event_id, occurrence_start) ON DELETE CASCADE,
  CHECK (player_one_id IS NULL OR player_two_id IS NULL OR player_one_id <> player_two_id),
  CHECK (winner_user_id IS NULL OR winner_user_id IN (player_one_id, player_two_id)),
  CHECK ((next_match_id IS NULL) = (next_slot IS NULL))
);

CREATE INDEX tournament_bracket_matches_round_idx
  ON tournament_bracket_matches (event_id, occurrence_start, round_number, match_number);

CREATE INDEX tournament_bracket_entrants_status_idx
  ON tournament_bracket_entrants (event_id, occurrence_start, status, created_at);

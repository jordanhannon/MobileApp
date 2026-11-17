ALTER TABLE events
  ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN recurrence_until DATE,
  DROP COLUMN ends_at,
  DROP COLUMN icon;

ALTER TABLE events
  ADD CONSTRAINT events_recurrence_check CHECK (recurrence IN ('none', 'weekly', 'monthly')),
  ADD CONSTRAINT events_recurrence_until_check CHECK (
    recurrence <> 'none' OR recurrence_until IS NULL
  );

ALTER TABLE event_rsvps
  ADD COLUMN occurrence_start TIMESTAMPTZ;

UPDATE event_rsvps r
SET occurrence_start = e.starts_at
FROM events e
WHERE e.id = r.event_id;

ALTER TABLE event_rsvps
  ALTER COLUMN occurrence_start SET NOT NULL,
  DROP CONSTRAINT event_rsvps_pkey,
  ADD PRIMARY KEY (event_id, occurrence_start, user_id);

DROP INDEX IF EXISTS event_rsvps_event_created_idx;
CREATE INDEX event_rsvps_event_occurrence_created_idx
  ON event_rsvps (event_id, occurrence_start, created_at, user_id);

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  Account, AdminReward, AdminUser, EventAttendee, EventInput, EventRecord, MemberEvent,
  PointsLedgerEntry, PointsSummary, RedemptionResult, Reward, UserRecord, UserRole,
} from './domain.js';
import { StoreError } from './domain.js';
import type { EmailTokenPurpose, Store } from './store.js';

type UserRow = QueryResultRow & {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  role: UserRole;
};

type AccountRow = QueryResultRow & {
  id: string;
  name: string;
  email: string;
  reward_points: string | number;
  role: UserRole;
};

type RewardRow = QueryResultRow & {
  id: string;
  name: string;
  points_cost: number;
  icon: string;
  active?: boolean;
};

type EventRow = QueryResultRow & {
  id: string;
  title: string;
  starts_at: Date;
  description: string;
  tag: string;
  capacity: number | null;
  rsvp_open: boolean;
  recurrence: EventRecord['recurrence'];
  recurrence_until: string | null;
  active: boolean;
};

type EventListRow = EventRow & {
  occurrence_start: Date;
  attendee_count: string | number;
  reserved: boolean | null;
};

type AdminUserRow = AccountRow & {
  email_verified_at: Date | null;
};

type LedgerRow = QueryResultRow & {
  id: string;
  delta: number;
  entry_type: string;
  reference_id: string | null;
  created_at: Date;
};

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    role: row.role,
  };
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    rewardPoints: Number(row.reward_points),
    role: row.role,
  };
}

function toReward(row: RewardRow): Reward {
  return { id: row.id, name: row.name, pointsCost: row.points_cost, icon: row.icon };
}

function toAdminReward(row: RewardRow): AdminReward {
  return { ...toReward(row), active: Boolean(row.active) };
}

function toEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    description: row.description,
    tag: row.tag,
    capacity: row.capacity,
    rsvpOpen: row.rsvp_open,
    recurrence: row.recurrence,
    recurrenceUntil: row.recurrence_until,
    active: row.active,
  };
}

function toMemberEvent(row: EventListRow): MemberEvent {
  return {
    ...toEvent(row),
    startsAt: row.occurrence_start.toISOString(),
    occurrenceStart: row.occurrence_start.toISOString(),
    attendeeCount: Number(row.attendee_count),
    reserved: Boolean(row.reserved),
  };
}

function toPointsLedgerEntry(row: LedgerRow): PointsLedgerEntry {
  return {
    id: row.id,
    delta: row.delta,
    entryType: row.entry_type,
    referenceId: row.reference_id,
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function accountByUserId(client: Pool | PoolClient, userId: string): Promise<Account> {
  const result = await client.query<AccountRow>(
    `SELECT u.id, u.name, u.email, u.role,
            COALESCE(SUM(l.delta), 0)::INTEGER AS reward_points
     FROM users u
     LEFT JOIN points_ledger l ON l.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Authenticated user was not found.');
  return toAccount(row);
}

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}

  async createUser(id: string, name: string, email: string, passwordHash: string): Promise<UserRecord | null> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO users (id, name, email, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, email, password_hash, email_verified_at, role`,
        [id, name, email, passwordHash],
      );
      return result.rows[0] ? toUser(result.rows[0]) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, name, email, password_hash, email_verified_at, role
       FROM users WHERE LOWER(email) = $1`,
      [email],
    );
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  async issueEmailToken(
    userId: string,
    purpose: EmailTokenPurpose,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE email_action_tokens SET consumed_at = NOW()
         WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [userId, purpose],
      );
      await client.query(
        `INSERT INTO email_action_tokens (id, user_id, purpose, token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [userId, purpose, tokenHash, expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyEmail(email: string, tokenHash: string): Promise<boolean> {
    return this.consumeEmailToken(email, 'verify_email', tokenHash, async (client, userId) => {
      await client.query(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1',
        [userId],
      );
    });
  }

  async resetPassword(email: string, tokenHash: string, passwordHash: string): Promise<boolean> {
    return this.consumeEmailToken(email, 'reset_password', tokenHash, async (client, userId) => {
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
    });
  }

  private async consumeEmailToken(
    email: string,
    purpose: EmailTokenPurpose,
    tokenHash: string,
    apply: (client: PoolClient, userId: string) => Promise<void>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const token = await client.query<QueryResultRow & {
        id: string;
        user_id: string;
        token_hash: string;
      }>(
        `SELECT t.id, t.user_id, t.token_hash
         FROM email_action_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE LOWER(u.email) = $1 AND t.purpose = $2
           AND t.expires_at > NOW() AND t.consumed_at IS NULL AND t.attempts < 5
         ORDER BY t.created_at DESC
         LIMIT 1
         FOR UPDATE OF t`,
        [email, purpose],
      );
      const row = token.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      const expected = Buffer.from(row.token_hash, 'hex');
      const received = Buffer.from(tokenHash, 'hex');
      const matches = expected.length === received.length && timingSafeEqual(expected, received);
      if (!matches) {
        await client.query('UPDATE email_action_tokens SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return false;
      }
      await client.query('UPDATE email_action_tokens SET consumed_at = NOW() WHERE id = $1', [row.id]);
      await apply(client, row.user_id);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createSession(
    id: string,
    userId: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account> {
    await this.pool.query(
      `INSERT INTO auth_sessions
         (id, user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, accessTokenHash, refreshTokenHash, accessExpiresAt, refreshExpiresAt],
    );
    return accountByUserId(this.pool, userId);
  }

  async findAccountByAccessTokenHash(accessTokenHash: string): Promise<Account | null> {
    const session = await this.pool.query<QueryResultRow & { user_id: string }>(
      `SELECT user_id FROM auth_sessions
       WHERE access_token_hash = $1 AND access_expires_at > NOW() AND revoked_at IS NULL`,
      [accessTokenHash],
    );
    if (!session.rows[0]) return null;
    return accountByUserId(this.pool, session.rows[0].user_id);
  }

  async rotateSession(
    oldRefreshTokenHash: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<QueryResultRow & { user_id: string }>(
        `UPDATE auth_sessions
         SET access_token_hash = $2, refresh_token_hash = $3,
             access_expires_at = $4, refresh_expires_at = $5
         WHERE refresh_token_hash = $1 AND refresh_expires_at > NOW() AND revoked_at IS NULL
         RETURNING user_id`,
        [oldRefreshTokenHash, accessTokenHash, refreshTokenHash, accessExpiresAt, refreshExpiresAt],
      );
      if (!result.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const account = await accountByUserId(client, result.rows[0].user_id);
      await client.query('COMMIT');
      return account;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeSession(refreshTokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = NOW() WHERE refresh_token_hash = $1 AND revoked_at IS NULL',
      [refreshTokenHash],
    );
  }

  async listRewards(): Promise<Reward[]> {
    const result = await this.pool.query<RewardRow>(
      'SELECT id, name, points_cost, icon FROM rewards WHERE active = TRUE ORDER BY points_cost, id',
    );
    return result.rows.map(toReward);
  }

  async redeem(userId: string, rewardId: string, idempotencyKey: string): Promise<RedemptionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      const existing = await client.query<
        QueryResultRow & {
          id: string;
          name: string;
          points_cost: number;
          icon: string;
          balance_after: number;
        }
      >(
        `SELECT d.id, r.name, d.points_cost, r.icon, d.balance_after
         FROM redemptions d JOIN rewards r ON r.id = d.reward_id
         WHERE d.user_id = $1 AND d.idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        await client.query('COMMIT');
        return {
          kind: 'redeemed',
          redemptionId: row.id,
          reward: { id: rewardId, name: row.name, pointsCost: row.points_cost, icon: row.icon },
          balance: row.balance_after,
          alreadyApplied: true,
        };
      }

      const rewardResult = await client.query<RewardRow>(
        'SELECT id, name, points_cost, icon FROM rewards WHERE id = $1 AND active = TRUE FOR SHARE',
        [rewardId],
      );
      const rewardRow = rewardResult.rows[0];
      if (!rewardRow) {
        await client.query('COMMIT');
        return { kind: 'reward_unavailable' };
      }

      const balanceResult = await client.query<QueryResultRow & { balance: string }>(
        'SELECT COALESCE(SUM(delta), 0)::INTEGER AS balance FROM points_ledger WHERE user_id = $1',
        [userId],
      );
      const balance = Number(balanceResult.rows[0].balance);
      if (balance < rewardRow.points_cost) {
        await client.query('COMMIT');
        return { kind: 'insufficient_points', balance };
      }

      const redemptionId = randomUUID();
      const balanceAfter = balance - rewardRow.points_cost;
      await client.query(
        `INSERT INTO redemptions (id, user_id, reward_id, idempotency_key, points_cost, balance_after)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [redemptionId, userId, rewardId, idempotencyKey, rewardRow.points_cost, balanceAfter],
      );
      await client.query(
        `INSERT INTO points_ledger (id, user_id, delta, entry_type, reference_id)
         VALUES ($1, $2, $3, 'redemption', $4)`,
        [randomUUID(), userId, -rewardRow.points_cost, redemptionId],
      );
      await client.query('COMMIT');
      return {
        kind: 'redeemed',
        redemptionId,
        reward: toReward(rewardRow),
        balance: balanceAfter,
        alreadyApplied: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(userId: string): Promise<MemberEvent[]> {
    const result = await this.pool.query<EventListRow>(
      `WITH clock AS (
         SELECT NOW() AS now_utc, NOW() AT TIME ZONE 'America/New_York' AS now_local
       ), anchors AS (
         SELECT e.*,
                e.starts_at AT TIME ZONE 'America/New_York' AS local_start,
                clock.now_utc,
                CASE e.recurrence
                  WHEN 'weekly' THEN GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (
                      clock.now_local - (e.starts_at AT TIME ZONE 'America/New_York')
                    )) / 604800)::INTEGER
                  )
                  WHEN 'monthly' THEN GREATEST(
                    0,
                    (
                      (EXTRACT(YEAR FROM clock.now_local)::INTEGER -
                       EXTRACT(YEAR FROM (e.starts_at AT TIME ZONE 'America/New_York'))::INTEGER) * 12
                      + EXTRACT(MONTH FROM clock.now_local)::INTEGER
                      - EXTRACT(MONTH FROM (e.starts_at AT TIME ZONE 'America/New_York'))::INTEGER
                      - 1
                    )
                  )
                  ELSE 0
                END AS first_index
         FROM events e
         CROSS JOIN clock
         WHERE e.active = TRUE
       ), generated AS (
         SELECT anchors.*,
                (
                  local_start + CASE recurrence
                    WHEN 'weekly' THEN indices.n * INTERVAL '1 week'
                    WHEN 'monthly' THEN indices.n * INTERVAL '1 month'
                    ELSE INTERVAL '0'
                  END
                ) AT TIME ZONE 'America/New_York' AS occurrence_start
         FROM anchors
         CROSS JOIN LATERAL generate_series(
           first_index,
           CASE WHEN recurrence = 'none' THEN 0 ELSE first_index + 12 END
         ) AS indices(n)
       ), ranked AS (
         SELECT generated.*,
                ROW_NUMBER() OVER (PARTITION BY id ORDER BY occurrence_start) AS occurrence_number
         FROM generated
         WHERE occurrence_start >= now_utc
           AND (
             recurrence_until IS NULL
             OR (occurrence_start AT TIME ZONE 'America/New_York')::DATE <= recurrence_until
           )
       )
       SELECT e.id, e.title, e.starts_at, e.description, e.tag, e.capacity,
              e.rsvp_open, e.recurrence, e.recurrence_until::TEXT AS recurrence_until, e.active,
              e.occurrence_start, COUNT(r.user_id)::INTEGER AS attendee_count,
              COALESCE(BOOL_OR(r.user_id = $1), FALSE) AS reserved
       FROM ranked e
       LEFT JOIN event_rsvps r
         ON r.event_id = e.id AND r.occurrence_start = e.occurrence_start
       WHERE e.occurrence_number <= 12
       GROUP BY e.id, e.title, e.starts_at, e.description, e.tag, e.capacity,
                e.rsvp_open, e.recurrence, e.recurrence_until, e.active, e.occurrence_start
       ORDER BY e.occurrence_start, e.id`,
      [userId],
    );
    return result.rows.map(toMemberEvent);
  }

  async rsvpToEvent(
    userId: string,
    eventId: string,
    occurrenceStart: string,
  ): Promise<'rsvped' | 'already_rsvped'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<QueryResultRow & {
        starts_at: Date;
        capacity: number | null;
        rsvp_open: boolean;
        recurrence: EventRecord['recurrence'];
        recurrence_until: string | null;
        active: boolean;
      }>(
        `SELECT starts_at, capacity, rsvp_open, recurrence,
                recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event || !event.active) throw new StoreError('event_not_found', 'Event not found.');
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);

      const existing = await client.query(
        'SELECT 1 FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2 AND user_id = $3',
        [eventId, occurrenceStart, userId],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return 'already_rsvped';
      }
      if (!event.rsvp_open) throw new StoreError('rsvp_closed', 'RSVPs are closed for this event.');

      const count = await client.query<QueryResultRow & { total: string }>(
        'SELECT COUNT(*)::TEXT AS total FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2',
        [eventId, occurrenceStart],
      );
      if (event.capacity !== null && Number(count.rows[0].total) >= event.capacity) {
        throw new StoreError('event_full', 'This event has reached capacity.');
      }

      await client.query(
        'INSERT INTO event_rsvps (event_id, occurrence_start, user_id) VALUES ($1, $2, $3)',
        [eventId, occurrenceStart, userId],
      );
      await client.query('COMMIT');
      return 'rsvped';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelEventRsvp(userId: string, eventId: string, occurrenceStart: string): Promise<boolean> {
    const eventResult = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open,
             recurrence, recurrence_until::TEXT AS recurrence_until, active
       FROM events WHERE id = $1`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event) throw new StoreError('event_not_found', 'Event not found.');
    await this.assertEventOccurrence(eventId, occurrenceStart, event, this.pool);
    const result = await this.pool.query(
      'DELETE FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2 AND user_id = $3',
      [eventId, occurrenceStart, userId],
    );
    return Boolean(result.rowCount);
  }

  async listEventAttendees(
    eventId: string,
    occurrenceStart: string,
    limit: number,
    offset: number,
  ): Promise<{ event: EventRecord; total: number; attendees: EventAttendee[] }> {
    const eventResult = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open,
             recurrence, recurrence_until::TEXT AS recurrence_until, active
       FROM events WHERE id = $1`,
      [eventId],
    );
    const eventRow = eventResult.rows[0];
    if (!eventRow) throw new StoreError('event_not_found', 'Event not found.');
    await this.assertEventOccurrence(eventId, occurrenceStart, eventRow, this.pool);

    const [countResult, attendeeResult] = await Promise.all([
      this.pool.query<QueryResultRow & { total: string }>(
        'SELECT COUNT(*)::TEXT AS total FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2',
        [eventId, occurrenceStart],
      ),
      this.pool.query<QueryResultRow & { user_id: string; name: string; created_at: Date }>(
        `SELECT u.id AS user_id, u.name, r.created_at
         FROM event_rsvps r
         JOIN users u ON u.id = r.user_id
         WHERE r.event_id = $1 AND r.occurrence_start = $2
         ORDER BY r.created_at, u.id
         LIMIT $3 OFFSET $4`,
        [eventId, occurrenceStart, limit, offset],
      ),
    ]);

    return {
      event: toEvent(eventRow),
      total: Number(countResult.rows[0].total),
      attendees: attendeeResult.rows.map(row => ({
        userId: row.user_id,
        name: row.name,
        rsvpAt: row.created_at.toISOString(),
      })),
    };
  }

  async searchUsers(
    query: string,
    limit: number,
    offset: number,
  ): Promise<{ users: AdminUser[]; total: number }> {
    const normalizedQuery = query.trim().toLowerCase();
    const predicate = `($1 = '' OR POSITION($1 IN LOWER(u.name)) > 0 OR POSITION($1 IN LOWER(u.email)) > 0)`;
    const [countResult, usersResult] = await Promise.all([
      this.pool.query<QueryResultRow & { total: string }>(
        `SELECT COUNT(*)::TEXT AS total FROM users u WHERE ${predicate}`,
        [normalizedQuery],
      ),
      this.pool.query<AdminUserRow>(
        `SELECT u.id, u.name, u.email, u.role, u.email_verified_at,
                COALESCE(b.balance, 0)::INTEGER AS reward_points
         FROM users u
         LEFT JOIN (
           SELECT user_id, SUM(delta)::BIGINT AS balance
           FROM points_ledger GROUP BY user_id
         ) b ON b.user_id = u.id
         WHERE ${predicate}
         ORDER BY LOWER(u.email), u.id
         LIMIT $2 OFFSET $3`,
        [normalizedQuery, limit, offset],
      ),
    ]);
    return {
      users: usersResult.rows.map(row => ({
        ...toAccount(row),
        emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
      })),
      total: Number(countResult.rows[0].total),
    };
  }

  async getPointsSummary(): Promise<PointsSummary> {
    const result = await this.pool.query<QueryResultRow & {
      total_users: string;
      users_with_points: string;
      total_points: string;
    }>(
      `WITH balances AS (
         SELECT user_id, SUM(delta)::BIGINT AS balance
         FROM points_ledger GROUP BY user_id
       )
       SELECT COUNT(*)::TEXT AS total_users,
              COUNT(*) FILTER (WHERE COALESCE(b.balance, 0) > 0)::TEXT AS users_with_points,
              COALESCE(SUM(b.balance), 0)::TEXT AS total_points
       FROM users u
       LEFT JOIN balances b ON b.user_id = u.id`,
    );
    const row = result.rows[0];
    return {
      totalUsers: Number(row.total_users),
      usersWithPoints: Number(row.users_with_points),
      totalPoints: Number(row.total_points),
    };
  }

  async getUserPoints(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ balance: number; entries: PointsLedgerEntry[]; total: number }> {
    const account = await accountByUserId(this.pool, userId);
    const [countResult, entriesResult] = await Promise.all([
      this.pool.query<QueryResultRow & { total: string }>(
        'SELECT COUNT(*)::TEXT AS total FROM points_ledger WHERE user_id = $1',
        [userId],
      ),
      this.pool.query<LedgerRow>(
        `SELECT id, delta, entry_type, reference_id, created_at
         FROM points_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
    ]);
    return {
      balance: account.rewardPoints,
      entries: entriesResult.rows.map(toPointsLedgerEntry),
      total: Number(countResult.rows[0].total),
    };
  }

  async listAdminEvents(): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open,
              recurrence, recurrence_until::TEXT AS recurrence_until, active
       FROM events ORDER BY starts_at, id`,
    );
    return result.rows.map(toEvent);
  }

  async listAdminRewards(): Promise<AdminReward[]> {
    const result = await this.pool.query<RewardRow>(
      'SELECT id, name, points_cost, icon, active FROM rewards ORDER BY points_cost, id',
    );
    return result.rows.map(toAdminReward);
  }

  async createEvent(actorId: string, input: EventInput): Promise<EventRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<EventRow>(
        `INSERT INTO events
           (id, title, starts_at, description, tag, capacity, rsvp_open, recurrence, recurrence_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [
          input.id, input.title, input.startsAt, input.description,
          input.tag, input.capacity, input.rsvpOpen, input.recurrence, input.recurrenceUntil,
        ],
      );
      const event = toEvent(result.rows[0]);
      await this.writeAudit(client, actorId, 'event.create', 'event', event.id, { after: event });
      await client.query('COMMIT');
      return event;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) throw new StoreError('event_conflict', 'An event with this ID already exists.');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateEvent(actorId: string, eventId: string, input: EventInput): Promise<EventRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new StoreError('event_not_found', 'Event not found.');
      const rsvpCount = await client.query<QueryResultRow & { total: string }>(
        'SELECT COUNT(*)::TEXT AS total FROM event_rsvps WHERE event_id = $1',
        [eventId],
      );
      if (Number(rsvpCount.rows[0].total) > 0 &&
        (current.starts_at.getTime() !== new Date(input.startsAt).getTime() ||
          current.recurrence !== input.recurrence ||
          current.recurrence_until !== input.recurrenceUntil)) {
        throw new StoreError(
          'event_schedule_conflict',
          'The event schedule cannot change after attendees have RSVP’d. Archive this series and create a new one.',
        );
      }
      const overCapacity = input.capacity === null ? false : (await client.query<QueryResultRow & { over_capacity: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM event_rsvps
           WHERE event_id = $1
           GROUP BY occurrence_start
           HAVING COUNT(*) > $2
         ) AS over_capacity`,
        [eventId, input.capacity],
      )).rows[0].over_capacity;
      if (overCapacity) {
        throw new StoreError('capacity_below_attendance', 'Capacity cannot be lower than the current RSVP count.');
      }
      const result = await client.query<EventRow>(
        `UPDATE events
         SET title = $2, starts_at = $3, description = $4, tag = $5, capacity = $6,
             rsvp_open = $7, recurrence = $8, recurrence_until = $9, updated_at = NOW()
         WHERE id = $1
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [
          eventId, input.title, input.startsAt, input.description, input.tag,
          input.capacity, input.rsvpOpen, input.recurrence, input.recurrenceUntil,
        ],
      );
      const event = toEvent(result.rows[0]);
      await this.writeAudit(client, actorId, 'event.update', 'event', eventId, {
        before: toEvent(current),
        after: event,
      });
      await client.query('COMMIT');
      return event;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async archiveEvent(actorId: string, eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<EventRow>(
        `UPDATE events SET active = FALSE, rsvp_open = FALSE, updated_at = NOW()
         WHERE id = $1 AND active = TRUE
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [eventId],
      );
      const event = result.rows[0];
      if (!event) throw new StoreError('event_not_found', 'Event not found or already archived.');
      await this.writeAudit(client, actorId, 'event.archive', 'event', eventId, {
        after: toEvent(event),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createReward(actorId: string, reward: Reward): Promise<AdminReward> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RewardRow>(
        `INSERT INTO rewards (id, name, points_cost, icon, active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, name, points_cost, icon, active`,
        [reward.id, reward.name, reward.pointsCost, reward.icon],
      );
      const created = toAdminReward(result.rows[0]);
      await this.writeAudit(client, actorId, 'reward.create', 'reward', created.id, { after: created });
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) throw new StoreError('reward_conflict', 'A reward with this ID already exists.');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateReward(
    actorId: string,
    rewardId: string,
    reward: Omit<Reward, 'id'>,
  ): Promise<AdminReward> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RewardRow>(
        'SELECT id, name, points_cost, icon, active FROM rewards WHERE id = $1 FOR UPDATE',
        [rewardId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new StoreError('reward_not_found', 'Reward not found.');
      const result = await client.query<RewardRow>(
        `UPDATE rewards SET name = $2, points_cost = $3, icon = $4
         WHERE id = $1
         RETURNING id, name, points_cost, icon, active`,
        [rewardId, reward.name, reward.pointsCost, reward.icon],
      );
      const updated = toAdminReward(result.rows[0]);
      await this.writeAudit(client, actorId, 'reward.update', 'reward', rewardId, {
        before: toAdminReward(current),
        after: updated,
      });
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async archiveReward(actorId: string, rewardId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RewardRow>(
        `UPDATE rewards SET active = FALSE
         WHERE id = $1 AND active = TRUE
         RETURNING id, name, points_cost, icon, active`,
        [rewardId],
      );
      const reward = result.rows[0];
      if (!reward) throw new StoreError('reward_not_found', 'Reward not found or already archived.');
      await this.writeAudit(client, actorId, 'reward.archive', 'reward', rewardId, {
        after: toAdminReward(reward),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async assignUserRole(actorId: string, userId: string, role: UserRole): Promise<void> {
    if (actorId === userId) throw new StoreError('self_role_change', 'Admins cannot change their own role.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(72610423::BIGINT)');
      const result = await client.query<QueryResultRow & { id: string; role: UserRole }>(
        'SELECT id, role FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const target = result.rows[0];
      if (!target) throw new StoreError('user_not_found', 'User not found.');
      if (target.role === role) {
        await client.query('COMMIT');
        return;
      }
      if (target.role === 'admin' && role !== 'admin') {
        const admins = await client.query<QueryResultRow & { total: string }>(
          "SELECT COUNT(*)::TEXT AS total FROM users WHERE role = 'admin'",
        );
        if (Number(admins.rows[0].total) <= 1) {
          throw new StoreError('last_admin', 'The last admin cannot be demoted.');
        }
      }
      await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
      await this.writeAudit(client, actorId, 'user.role_change', 'user', userId, {
        before: { role: target.role },
        after: { role },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertEventOccurrence(
    eventId: string,
    occurrenceStart: string,
    event: Pick<EventRow, 'starts_at' | 'recurrence' | 'recurrence_until'>,
    executor: Pool | PoolClient,
  ): Promise<void> {
    const result = await executor.query<QueryResultRow & { valid: boolean }>(
      `WITH values AS (
         SELECT $1::TIMESTAMPTZ AS occurrence_start,
                $2::TIMESTAMPTZ AS starts_at,
                $3::TEXT AS recurrence,
                $4::DATE AS recurrence_until
       ), local_values AS (
         SELECT *,
                occurrence_start AT TIME ZONE 'America/New_York' AS occurrence_local,
                starts_at AT TIME ZONE 'America/New_York' AS start_local
         FROM values
       ), indexed AS (
         SELECT *,
                (
                  (EXTRACT(YEAR FROM occurrence_local)::INTEGER -
                   EXTRACT(YEAR FROM start_local)::INTEGER) * 12
                  + EXTRACT(MONTH FROM occurrence_local)::INTEGER
                  - EXTRACT(MONTH FROM start_local)::INTEGER
                ) AS month_index
         FROM local_values
       )
       SELECT
         CASE recurrence
           WHEN 'none' THEN occurrence_start = starts_at
           WHEN 'weekly' THEN occurrence_local >= start_local
             AND MOD(EXTRACT(EPOCH FROM (occurrence_local - start_local))::NUMERIC, 604800) = 0
           WHEN 'monthly' THEN occurrence_local >= start_local
             AND occurrence_local = start_local + month_index * INTERVAL '1 month'
           ELSE FALSE
         END
         AND (recurrence_until IS NULL OR occurrence_local::DATE <= recurrence_until) AS valid
       FROM indexed`,
      [occurrenceStart, event.starts_at, event.recurrence, event.recurrence_until],
    );
    if (!result.rows[0]?.valid) {
      throw new StoreError('event_occurrence_not_found', `The requested occurrence is not part of event ${eventId}.`);
    }
  }

  private async writeAudit(
    client: PoolClient,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    changes: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO admin_audit_log (id, actor_user_id, action, target_type, target_id, changes)
       VALUES ($1, $2, $3, $4, $5, $6::JSONB)`,
      [randomUUID(), actorId, action, targetType, targetId, JSON.stringify(changes)],
    );
  }
}

import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  Account, AdminReward, AdminUser, AnnouncementAudience, AppNotification, BracketGuest, BracketMatch,
  EventAttendee, EventInput, EventRecord, ExpoReceipt, MemberEvent, NotificationPage,
  NotificationPreferences, NotificationType, PushDelivery, PushPlatform, PointsLedgerEntry,
  PointsSummary, RedemptionResult, Reward, SocialIdentityInput, SocialIdentityResult,
  TournamentBracket, UserRecord, UserRole,
} from './domain.js';
import { StoreError } from './domain.js';
import type { EmailTokenPurpose, Store } from './store.js';
import { normalizeEmail } from './crypto.js';

type UserRow = QueryResultRow & {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
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
  bracket_enabled: boolean;
  recurrence: EventRecord['recurrence'];
  recurrence_until: string | null;
  active: boolean;
};

type EventListRow = EventRow & {
  occurrence_start: Date;
  attendee_count: string | number;
  bracket_participant_count: string | number;
  reserved: boolean | null;
  bracket_status: 'drawn' | 'completed' | null;
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

type NotificationRow = QueryResultRow & {
  id: string;
  notification_type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
};

type PreferenceRow = QueryResultRow & {
  rsvp_updates_enabled: boolean;
  event_changes_enabled: boolean;
  rewards_enabled: boolean;
  announcements_enabled: boolean;
  push_enabled: boolean;
  reminder_schedule: NotificationPreferences['reminderSchedule'];
};

type NotificationCategory = 'rsvp' | 'event' | 'rewards' | 'announcements';

type NewNotification = {
  userId: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, string>;
  dedupeKey: string;
};

type BracketMatchDraft = {
  id: string;
  roundNumber: number;
  matchNumber: number;
  playerOneId: string | null;
  playerTwoId: string | null;
  winnerEntrantId: string | null;
  nextMatchId: string | null;
  nextSlot: 'one' | 'two' | null;
};

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function makeBracketMatches(userIds: string[]): BracketMatchDraft[] {
  let slotCount = 1;
  while (slotCount < userIds.length) slotCount *= 2;
  const shuffledIds = shuffle(userIds);
  const byes = slotCount - shuffledIds.length;
  const roundCounts: number[] = [];
  for (let count = slotCount / 2; count >= 1; count /= 2) roundCounts.push(count);

  const rounds = roundCounts.map((count, roundIndex) =>
    Array.from({ length: count }, (_, index): BracketMatchDraft => ({
      id: randomUUID(),
      roundNumber: roundIndex + 1,
      matchNumber: index + 1,
      playerOneId: null,
      playerTwoId: null,
      winnerEntrantId: null,
      nextMatchId: null,
      nextSlot: null,
    })),
  );
  for (let roundIndex = 0; roundIndex < rounds.length - 1; roundIndex += 1) {
    rounds[roundIndex].forEach((match, index) => {
      match.nextMatchId = rounds[roundIndex + 1][Math.floor(index / 2)].id;
      match.nextSlot = index % 2 === 0 ? 'one' : 'two';
    });
  }

  const firstRound = rounds[0];
  for (let index = 0; index < firstRound.length; index += 1) {
    const match = firstRound[index];
    if (index < byes) {
      match.playerOneId = shuffledIds[index];
      match.winnerEntrantId = shuffledIds[index];
    } else {
      const entrantIndex = byes + (index - byes) * 2;
      match.playerOneId = shuffledIds[entrantIndex];
      match.playerTwoId = shuffledIds[entrantIndex + 1];
    }
    if (match.winnerEntrantId && match.nextMatchId) {
      const next = rounds[1][Math.floor(index / 2)];
      if (match.nextSlot === 'one') next.playerOneId = match.winnerEntrantId;
      else next.playerTwoId = match.winnerEntrantId;
    }
  }
  return rounds.flat();
}

type BracketEntrantRow = QueryResultRow & {
  entrant_id: string;
  user_id: string | null;
  name: string;
  status?: 'active' | 'waitlisted';
};

type BracketMatchRow = QueryResultRow & {
  id: string;
  round_number: number;
  match_number: number;
  player_one_entrant_id: string | null;
  player_one_name: string | null;
  player_one_user_id: string | null;
  player_two_entrant_id: string | null;
  player_two_name: string | null;
  player_two_user_id: string | null;
  winner_entrant_id: string | null;
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
    bracketEnabled: row.bracket_enabled,
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
    bracketParticipantCount: Number(row.bracket_participant_count),
    reserved: Boolean(row.reserved),
    bracketStatus: row.bracket_status,
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

function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.notification_type,
    title: row.title,
    body: row.body,
    data: Object.fromEntries(Object.entries(row.data ?? {}).map(([key, value]) => [key, String(value)])),
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

function toNotificationPreferences(row?: PreferenceRow): NotificationPreferences {
  return {
    rsvpUpdatesEnabled: row?.rsvp_updates_enabled ?? true,
    eventChangesEnabled: row?.event_changes_enabled ?? true,
    rewardsEnabled: row?.rewards_enabled ?? true,
    announcementsEnabled: row?.announcements_enabled ?? true,
    pushEnabled: row?.push_enabled ?? true,
    reminderSchedule: row?.reminder_schedule ?? '24h',
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

  private async createNotification(client: PoolClient, input: NewNotification): Promise<string | null> {
    const preferenceResult = await client.query<PreferenceRow>(
      `SELECT COALESCE(rsvp_updates_enabled, TRUE) AS rsvp_updates_enabled,
              COALESCE(event_changes_enabled, TRUE) AS event_changes_enabled,
              COALESCE(rewards_enabled, TRUE) AS rewards_enabled,
              COALESCE(announcements_enabled, TRUE) AS announcements_enabled,
              COALESCE(push_enabled, TRUE) AS push_enabled,
              COALESCE(reminder_schedule, '24h') AS reminder_schedule
       FROM notification_preferences WHERE user_id = $1`,
      [input.userId],
    );
    const preferences = toNotificationPreferences(preferenceResult.rows[0]);
    const categoryEnabled = input.category === 'rsvp'
      ? preferences.rsvpUpdatesEnabled
      : input.category === 'event'
        ? preferences.eventChangesEnabled
        : input.category === 'rewards'
          ? preferences.rewardsEnabled
          : preferences.announcementsEnabled;
    if (!categoryEnabled) return null;

    const inserted = await client.query<QueryResultRow & { id: string }>(
      `INSERT INTO notifications (id, user_id, notification_type, title, body, data, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.userId, input.type, input.title, input.body, JSON.stringify(input.data), input.dedupeKey],
    );
    const notificationId = inserted.rows[0]?.id;
    if (!notificationId) return null;

    if (preferences.pushEnabled) {
      await client.query(
        `INSERT INTO notification_push_outbox (id, notification_id, push_token_id)
         SELECT gen_random_uuid(), $1, id FROM notification_push_tokens
         WHERE user_id = $2 AND revoked_at IS NULL
         ON CONFLICT (notification_id, push_token_id) DO NOTHING`,
        [notificationId, input.userId],
      );
    }
    return notificationId;
  }

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

  async issueSocialNonce(
    provider: SocialIdentityInput['provider'],
    nonceHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM auth_provider_nonces
       WHERE expires_at < NOW() - INTERVAL '1 day'`,
    );
    await this.pool.query(
      `INSERT INTO auth_provider_nonces (provider, nonce_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [provider, nonceHash, expiresAt],
    );
  }

  async resolveSocialIdentity(input: SocialIdentityInput): Promise<SocialIdentityResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const challenge = await client.query(
        `SELECT nonce_hash FROM auth_provider_nonces
         WHERE provider = $1 AND nonce_hash = $2
           AND expires_at > NOW() AND consumed_at IS NULL
         FOR UPDATE`,
        [input.provider, input.nonceHash],
      );
      if (!challenge.rows[0]) throw new StoreError('social_nonce_invalid', 'Sign-in request expired. Please try again.');

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`social:${input.provider}:${input.subject}`],
      );
      let identityUser = await this.findSocialIdentityUser(client, input.provider, input.subject);
      if (identityUser) {
        await this.consumeSocialNonce(client, input.provider, input.nonceHash);
        await client.query('COMMIT');
        return { kind: 'authenticated', user: identityUser };
      }

      if (!input.email || !input.emailVerified) {
        throw new StoreError('social_email_unverified', 'A verified email address is required for this sign-in method.');
      }
      const email = normalizeEmail(input.email);

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`email:${email}`],
      );
      identityUser = await this.findSocialIdentityUser(client, input.provider, input.subject);
      if (identityUser) {
        await this.consumeSocialNonce(client, input.provider, input.nonceHash);
        await client.query('COMMIT');
        return { kind: 'authenticated', user: identityUser };
      }

      const existing = await client.query<UserRow>(
        `SELECT id, name, email, password_hash, email_verified_at, role
         FROM users WHERE LOWER(email) = $1
         FOR UPDATE`,
        [email],
      );
      let user: UserRecord;
      if (existing.rows[0]) {
        const verified = await client.query<UserRow>(
          `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
           WHERE id = $1
           RETURNING id, name, email, password_hash, email_verified_at, role`,
          [existing.rows[0].id],
        );
        user = toUser(verified.rows[0]);
      } else {
        const name = input.name?.trim();
        if (!name) {
          await client.query('COMMIT');
          return { kind: 'profile_required' };
        }
        const inserted = await client.query<UserRow>(
          `INSERT INTO users (id, name, email, password_hash, email_verified_at)
           VALUES ($1, $2, $3, NULL, NOW())
           RETURNING id, name, email, password_hash, email_verified_at, role`,
          [input.id, name, email],
        );
        user = toUser(inserted.rows[0]);
      }

      try {
        await client.query(
          `INSERT INTO user_auth_identities (provider, subject, user_id)
           VALUES ($1, $2, $3)`,
          [input.provider, input.subject, user.id],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreError('social_identity_conflict', 'This sign-in method is already linked to another account.');
        }
        throw error;
      }
      await this.consumeSocialNonce(client, input.provider, input.nonceHash);
      await client.query('COMMIT');
      return { kind: 'authenticated', user };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findSocialIdentityUser(
    client: PoolClient,
    provider: SocialIdentityInput['provider'],
    subject: string,
  ): Promise<UserRecord | null> {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.name, u.email, u.password_hash, u.email_verified_at, u.role
       FROM user_auth_identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.provider = $1 AND i.subject = $2
       FOR UPDATE OF u`,
      [provider, subject],
    );
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  private async consumeSocialNonce(
    client: PoolClient,
    provider: SocialIdentityInput['provider'],
    nonceHash: string,
  ): Promise<void> {
    const consumed = await client.query(
      `UPDATE auth_provider_nonces SET consumed_at = NOW()
       WHERE provider = $1 AND nonce_hash = $2 AND consumed_at IS NULL`,
      [provider, nonceHash],
    );
    if (consumed.rowCount !== 1) {
      throw new StoreError('social_nonce_invalid', 'Sign-in request expired. Please try again.');
    }
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
      await this.createNotification(client, {
        userId,
        category: 'rewards',
        type: 'reward_redeemed',
        title: 'Reward redeemed',
        body: `${rewardRow.name} was redeemed. Your updated balance is ${balanceAfter} points.`,
        data: { screen: 'Rewards', redemptionId },
        dedupeKey: `reward-redemption:${redemptionId}`,
      });
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

  async listNotifications(userId: string, limit: number, offset: number): Promise<NotificationPage> {
    const [feed, counts] = await Promise.all([
      this.pool.query<NotificationRow>(
        `SELECT id, notification_type, title, body, data, created_at, read_at
         FROM notifications
         WHERE user_id = $1 AND expires_at > NOW()
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      this.pool.query<QueryResultRow & { total: string; unread_count: string }>(
        `SELECT COUNT(*)::TEXT AS total,
                COUNT(*) FILTER (WHERE read_at IS NULL)::TEXT AS unread_count
         FROM notifications WHERE user_id = $1 AND expires_at > NOW()`,
        [userId],
      ),
    ]);
    return {
      items: feed.rows.map(toNotification),
      total: Number(counts.rows[0].total),
      unreadCount: Number(counts.rows[0].unread_count),
    };
  }

  async markNotificationRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [notificationId, userId],
    );
    return Boolean(result.rowCount);
  }

  async markAllNotificationsRead(userId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL AND expires_at > NOW()`,
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
    const result = await this.pool.query<PreferenceRow>(
      `SELECT rsvp_updates_enabled, event_changes_enabled, rewards_enabled,
              announcements_enabled, push_enabled, reminder_schedule
       FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    return toNotificationPreferences(result.rows[0]);
  }

  async updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<PreferenceRow>(
        `INSERT INTO notification_preferences (
           user_id, rsvp_updates_enabled, event_changes_enabled, rewards_enabled,
           announcements_enabled, push_enabled, reminder_schedule, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           rsvp_updates_enabled = EXCLUDED.rsvp_updates_enabled,
           event_changes_enabled = EXCLUDED.event_changes_enabled,
           rewards_enabled = EXCLUDED.rewards_enabled,
           announcements_enabled = EXCLUDED.announcements_enabled,
           push_enabled = EXCLUDED.push_enabled,
           reminder_schedule = EXCLUDED.reminder_schedule,
           updated_at = NOW()
         RETURNING rsvp_updates_enabled, event_changes_enabled, rewards_enabled,
                   announcements_enabled, push_enabled, reminder_schedule`,
        [
          userId, preferences.rsvpUpdatesEnabled, preferences.eventChangesEnabled,
          preferences.rewardsEnabled, preferences.announcementsEnabled,
          preferences.pushEnabled, preferences.reminderSchedule,
        ],
      );
      await client.query(
        `UPDATE notification_push_outbox o
         SET status = 'failed', last_error = 'Disabled by recipient preferences',
             locked_until = NULL, updated_at = NOW()
         FROM notifications n
         WHERE n.id = o.notification_id AND n.user_id = $1 AND o.status = 'pending'
           AND (
             NOT $2
             OR (n.notification_type IN ('rsvp_confirmed', 'rsvp_cancelled', 'event_reminder') AND NOT $3)
             OR (n.notification_type IN ('event_changed', 'event_cancelled') AND NOT $4)
             OR (n.notification_type IN ('points_earned', 'reward_redeemed') AND NOT $5)
             OR (n.notification_type = 'announcement' AND NOT $6)
           )`,
        [
          userId, preferences.pushEnabled, preferences.rsvpUpdatesEnabled,
          preferences.eventChangesEnabled, preferences.rewardsEnabled,
          preferences.announcementsEnabled,
        ],
      );
      await client.query('COMMIT');
      return toNotificationPreferences(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async registerPushToken(userId: string, token: string, platform: PushPlatform): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE notification_push_outbox
         SET status = 'failed', last_error = 'Push token was reassigned',
             locked_until = NULL, updated_at = NOW()
         WHERE push_token_id = (
           SELECT id FROM notification_push_tokens WHERE expo_push_token = $1
         ) AND status = 'pending'`,
        [token],
      );
      await client.query(
        `INSERT INTO notification_push_tokens (id, user_id, expo_push_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (expo_push_token) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           platform = EXCLUDED.platform,
           last_seen_at = NOW(),
           revoked_at = NULL`,
        [randomUUID(), userId, token, platform],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokePushToken(userId: string, token: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE notification_push_tokens SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE user_id = $1 AND expo_push_token = $2`,
        [userId, token],
      );
      await client.query(
        `UPDATE notification_push_outbox SET status = 'failed',
         last_error = 'Push token was revoked', locked_until = NULL, updated_at = NOW()
         WHERE status = 'pending' AND push_token_id = (
           SELECT id FROM notification_push_tokens WHERE user_id = $1 AND expo_push_token = $2
         )`,
        [userId, token],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createAnnouncement(
    actorId: string,
    title: string,
    body: string,
    audience: AnnouncementAudience,
    idempotencyKey: string,
  ): Promise<{ recipients: number; alreadyApplied: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scopedIdempotencyKey = `${actorId}:${idempotencyKey}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`announcement:${scopedIdempotencyKey}`]);
      const existing = await client.query<QueryResultRow & { id: string }>(
        'SELECT id FROM staff_announcements WHERE idempotency_key = $1',
        [scopedIdempotencyKey],
      );
      if (existing.rows[0]) {
        const count = await client.query<QueryResultRow & { total: string }>(
          `SELECT COUNT(*)::TEXT AS total FROM notifications
           WHERE dedupe_key = $1`,
          [`announcement:${existing.rows[0].id}`],
        );
        await client.query('COMMIT');
        return { recipients: Number(count.rows[0].total), alreadyApplied: true };
      }

      const announcementId = randomUUID();
      let recipientIds: string[];
      if (audience.type === 'all') {
        const recipients = await client.query<QueryResultRow & { id: string }>(
          `SELECT id FROM users WHERE role = 'member' ORDER BY id`,
        );
        recipientIds = recipients.rows.map(row => row.id);
      } else {
        const event = await client.query<QueryResultRow & { active: boolean }>(
          'SELECT active FROM events WHERE id = $1',
          [audience.eventId],
        );
        if (!event.rows[0]?.active) throw new StoreError('event_not_found', 'Event not found.');
        const recipients = await client.query<QueryResultRow & { user_id: string }>(
          `SELECT DISTINCT user_id FROM event_rsvps
           WHERE event_id = $1 AND occurrence_start = $2`,
          [audience.eventId, audience.occurrenceStart],
        );
        recipientIds = recipients.rows.map(row => row.user_id);
      }

      await client.query(
        `INSERT INTO staff_announcements (id, actor_id, idempotency_key, title, body, audience)
         VALUES ($1, $2, $3, $4, $5, $6::JSONB)`,
        [announcementId, actorId, scopedIdempotencyKey, title, body, JSON.stringify(audience)],
      );
      let created = 0;
      for (const userId of recipientIds) {
        const notificationId = await this.createNotification(client, {
          userId,
          category: 'announcements',
          type: 'announcement',
          title,
          body,
          data: audience.type === 'event'
            ? { screen: 'Events', eventId: audience.eventId, occurrenceStart: audience.occurrenceStart }
            : { screen: 'Events' },
          dedupeKey: `announcement:${announcementId}`,
        });
        if (notificationId) created += 1;
      }
      await this.writeAudit(client, actorId, 'announcement.publish', 'announcement', announcementId, {
        title,
        audience,
        recipientCount: created,
      });
      await client.query('COMMIT');
      return { recipients: created, alreadyApplied: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueueDueEventReminders(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<QueryResultRow & {
        user_id: string;
        event_id: string;
        occurrence_start: Date;
        title: string;
        reminder_offset: '24h' | '1h';
      }>(
        `SELECT r.user_id, r.event_id, r.occurrence_start, e.title, reminder.offset_code AS reminder_offset
         FROM event_rsvps r
         JOIN events e ON e.id = r.event_id AND e.active = TRUE
         LEFT JOIN notification_preferences p ON p.user_id = r.user_id
         CROSS JOIN (VALUES ('24h'::TEXT, INTERVAL '24 hours'), ('1h'::TEXT, INTERVAL '1 hour'))
           AS reminder(offset_code, duration)
         WHERE r.occurrence_start > NOW()
           AND r.occurrence_start <= NOW() + reminder.duration
           AND (
             COALESCE(p.reminder_schedule, '24h') = '24h_1h'
             OR (reminder.offset_code = '24h' AND COALESCE(p.reminder_schedule, '24h') = '24h')
             OR (reminder.offset_code = '1h' AND COALESCE(p.reminder_schedule, '24h') = '1h')
           )
         ORDER BY r.occurrence_start, r.user_id`,
      );
      for (const item of due.rows) {
        const occurrenceStart = item.occurrence_start.toISOString();
        await this.createNotification(client, {
          userId: item.user_id,
          category: 'rsvp',
          type: 'event_reminder',
          title: 'Event reminder',
          body: `Reminder: You RSVP'd to ${item.title}.`,
          data: { screen: 'Events', eventId: item.event_id, occurrenceStart },
          dedupeKey: `event-reminder:${item.event_id}:${occurrenceStart}:${item.reminder_offset}`,
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPushDeliveries(limit: number): Promise<PushDelivery[]> {
    const result = await this.pool.query<QueryResultRow & {
      id: string;
      notification_id: string;
      expo_push_token: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      attempt_count: number;
    }>(
      `WITH candidates AS (
         SELECT o.id
         FROM notification_push_outbox o
         JOIN notifications n ON n.id = o.notification_id AND n.expires_at > NOW()
         JOIN notification_push_tokens t ON t.id = o.push_token_id AND t.revoked_at IS NULL
         LEFT JOIN notification_preferences p ON p.user_id = n.user_id
         WHERE (
             (o.status = 'pending' AND o.next_attempt_at <= NOW())
             OR (o.status = 'processing' AND o.locked_until <= NOW())
           )
           AND COALESCE(p.push_enabled, TRUE)
           AND (
             (n.notification_type IN ('rsvp_confirmed', 'rsvp_cancelled', 'event_reminder') AND COALESCE(p.rsvp_updates_enabled, TRUE))
             OR (n.notification_type IN ('event_changed', 'event_cancelled') AND COALESCE(p.event_changes_enabled, TRUE))
             OR (n.notification_type IN ('points_earned', 'reward_redeemed') AND COALESCE(p.rewards_enabled, TRUE))
             OR (n.notification_type = 'announcement' AND COALESCE(p.announcements_enabled, TRUE))
           )
         ORDER BY o.next_attempt_at, o.created_at
         FOR UPDATE OF o SKIP LOCKED
         LIMIT $1
       ), claimed AS (
         UPDATE notification_push_outbox o
         SET status = 'processing', attempt_count = attempt_count + 1,
             locked_until = NOW() + INTERVAL '5 minutes', updated_at = NOW()
         FROM candidates c
         WHERE o.id = c.id
         RETURNING o.id, o.notification_id, o.push_token_id, o.attempt_count
       )
       SELECT c.id, c.notification_id, t.expo_push_token, n.title, n.body, n.data, c.attempt_count
       FROM claimed c
       JOIN notification_push_tokens t ON t.id = c.push_token_id
       JOIN notifications n ON n.id = c.notification_id`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows.map(row => ({
      id: row.id,
      notificationId: row.notification_id,
      token: row.expo_push_token,
      title: row.title,
      body: row.body,
      data: Object.fromEntries(Object.entries(row.data ?? {}).map(([key, value]) => [key, String(value)])),
      attemptCount: row.attempt_count,
    }));
  }

  async markPushDeliverySubmitted(deliveryId: string, ticketId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE notification_push_outbox
       SET status = 'submitted', expo_ticket_id = $2,
           receipt_check_at = NOW() + INTERVAL '15 minutes',
           locked_until = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [deliveryId, ticketId],
    );
    if (!result.rowCount) throw new Error('Push delivery was no longer claimed.');
  }

  async retryPushDelivery(deliveryId: string, error: string, delaySeconds: number): Promise<void> {
    await this.pool.query(
      `UPDATE notification_push_outbox
       SET status = CASE WHEN attempt_count >= 5 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = NOW() + ($3::TEXT || ' seconds')::INTERVAL,
           locked_until = NULL, last_error = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [deliveryId, error.slice(0, 500), Math.max(1, Math.min(delaySeconds, 3600))],
    );
  }

  async failPushDelivery(deliveryId: string, error: string, deactivateToken: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (deactivateToken) {
        await client.query(
          `UPDATE notification_push_tokens SET revoked_at = COALESCE(revoked_at, NOW())
           WHERE id = (SELECT push_token_id FROM notification_push_outbox WHERE id = $1)`,
          [deliveryId],
        );
      }
      await client.query(
        `UPDATE notification_push_outbox
         SET status = 'failed', locked_until = NULL, receipt_check_at = NULL,
             last_error = $2, updated_at = NOW()
         WHERE id = $1`,
        [deliveryId, error.slice(0, 500)],
      );
      await client.query('COMMIT');
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally {
      client.release();
    }
  }

  async listDueExpoReceipts(limit: number): Promise<ExpoReceipt[]> {
    const result = await this.pool.query<QueryResultRow & {
      id: string;
      expo_ticket_id: string;
      attempt_count: number;
    }>(
      `WITH candidates AS (
         SELECT id FROM notification_push_outbox
         WHERE status = 'submitted' AND receipt_check_at <= NOW()
         ORDER BY receipt_check_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE notification_push_outbox o
       SET receipt_check_at = NOW() + INTERVAL '15 minutes', updated_at = NOW()
       FROM candidates c
       WHERE o.id = c.id
       RETURNING o.id, o.expo_ticket_id, o.attempt_count`,
      [Math.min(Math.max(limit, 1), 300)],
    );
    return result.rows.flatMap(row => row.expo_ticket_id
      ? [{ id: row.id, ticketId: row.expo_ticket_id, attemptCount: row.attempt_count }]
      : []);
  }

  async markExpoReceiptDelivered(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE notification_push_outbox
       SET status = 'delivered', receipt_check_at = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'submitted'`,
      [deliveryId],
    );
  }

  async markExpoReceiptFailed(deliveryId: string, error: string, deactivateToken: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (deactivateToken) {
        await client.query(
          `UPDATE notification_push_tokens SET revoked_at = COALESCE(revoked_at, NOW())
           WHERE id = (SELECT push_token_id FROM notification_push_outbox WHERE id = $1)`,
          [deliveryId],
        );
      }
      await client.query(
        `UPDATE notification_push_outbox
         SET status = 'failed', receipt_check_at = NULL, last_error = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'submitted'`,
        [deliveryId, error.slice(0, 500)],
      );
      await client.query('COMMIT');
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally {
      client.release();
    }
  }

  async cleanupNotifications(): Promise<void> {
    await this.pool.query('DELETE FROM notifications WHERE expires_at <= NOW()');
    await this.pool.query(
      `DELETE FROM notification_push_tokens
       WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '90 days')
          OR (revoked_at IS NULL AND last_seen_at < NOW() - INTERVAL '90 days')`,
    );
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
       ), occurrences AS (
         SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until, active, occurrence_start,
                NULL::TEXT AS bracket_status
         FROM ranked
         WHERE occurrence_number <= 12
         UNION ALL
         SELECT e.id, e.title, e.starts_at, e.description, e.tag, e.capacity, e.rsvp_open,
                e.bracket_enabled, e.recurrence, e.recurrence_until, e.active,
                b.occurrence_start, b.status
         FROM events e
         JOIN tournament_brackets b ON b.event_id = e.id
         WHERE e.active = TRUE AND e.bracket_enabled = TRUE
           AND b.status = 'drawn' AND b.occurrence_start < NOW()
       )
       SELECT e.id, e.title, e.starts_at, e.description, e.tag, e.capacity,
              e.rsvp_open, e.bracket_enabled, e.recurrence,
              e.recurrence_until::TEXT AS recurrence_until, e.active,
              e.occurrence_start, e.bracket_status, COUNT(r.user_id)::INTEGER AS attendee_count,
              (
                SELECT COUNT(*) FROM event_rsvps r2
                WHERE r2.event_id = e.id AND r2.occurrence_start = e.occurrence_start
              ) + (
                SELECT COUNT(*) FROM event_bracket_guests g2
                WHERE g2.event_id = e.id AND g2.occurrence_start = e.occurrence_start
              ) AS bracket_participant_count,
              COALESCE(BOOL_OR(r.user_id = $1), FALSE) AS reserved
       FROM occurrences e
       LEFT JOIN event_rsvps r
         ON r.event_id = e.id AND r.occurrence_start = e.occurrence_start
       GROUP BY e.id, e.title, e.starts_at, e.description, e.tag, e.capacity,
                e.rsvp_open, e.bracket_enabled, e.recurrence, e.recurrence_until,
                e.active, e.occurrence_start, e.bracket_status
       ORDER BY e.occurrence_start, e.id`,
      [userId],
    );
    return result.rows.map(toMemberEvent);
  }

  async listEventsForMonth(userId: string, monthStart: string): Promise<MemberEvent[]> {
    const result = await this.pool.query<EventListRow>(
      `WITH month_bounds AS (
         SELECT $2::DATE AS month_start, ($2::DATE + INTERVAL '1 month')::DATE AS month_end
       ), anchors AS (
         SELECT e.*,
                e.starts_at AT TIME ZONE 'America/New_York' AS local_start,
                bounds.month_start::TIMESTAMP AS local_month_start,
                bounds.month_end::TIMESTAMP AS local_month_end,
                bounds.month_start,
                bounds.month_end
         FROM events e
         CROSS JOIN month_bounds bounds
         WHERE e.active = TRUE
       ), offsets AS (
         SELECT anchors.*,
                ((EXTRACT(YEAR FROM local_month_start)::INTEGER -
                  EXTRACT(YEAR FROM local_start)::INTEGER) * 12
                  + EXTRACT(MONTH FROM local_month_start)::INTEGER
                  - EXTRACT(MONTH FROM local_start)::INTEGER) AS month_offset
         FROM anchors
       ), indexed AS (
         SELECT offsets.*,
                CASE recurrence
                  WHEN 'weekly' THEN GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (local_month_start - local_start)) / 604800)::INTEGER - 1
                  )
                  WHEN 'monthly' THEN GREATEST(0, month_offset - 1)
                  ELSE 0
                END AS first_index,
                CASE recurrence
                  WHEN 'weekly' THEN GREATEST(
                    0,
                    CEIL(EXTRACT(EPOCH FROM (local_month_end - local_start)) / 604800)::INTEGER + 1
                  )
                  WHEN 'monthly' THEN GREATEST(0, month_offset + 1)
                  ELSE 0
                END AS last_index
         FROM offsets
       ), generated AS (
         SELECT indexed.*,
                (
                  local_start + CASE recurrence
                    WHEN 'weekly' THEN indices.n * INTERVAL '1 week'
                    WHEN 'monthly' THEN indices.n * INTERVAL '1 month'
                    ELSE INTERVAL '0'
                  END
                ) AT TIME ZONE 'America/New_York' AS occurrence_start
         FROM indexed
         CROSS JOIN LATERAL generate_series(first_index, last_index) AS indices(n)
       ), occurrences AS (
         SELECT *
         FROM generated
         WHERE occurrence_start >= (month_start::TIMESTAMP AT TIME ZONE 'America/New_York')
           AND occurrence_start < (month_end::TIMESTAMP AT TIME ZONE 'America/New_York')
           AND (
             recurrence_until IS NULL
             OR (occurrence_start AT TIME ZONE 'America/New_York')::DATE <= recurrence_until
           )
       )
       SELECT e.id, e.title, e.starts_at, e.description, e.tag, e.capacity,
              e.rsvp_open, e.bracket_enabled, e.recurrence,
              e.recurrence_until::TEXT AS recurrence_until, e.active,
              e.occurrence_start, b.status AS bracket_status,
              (
                SELECT COUNT(*)::INTEGER FROM event_rsvps r
                WHERE r.event_id = e.id AND r.occurrence_start = e.occurrence_start
              ) AS attendee_count,
              (
                SELECT (
                  (SELECT COUNT(*) FROM event_rsvps r
                   WHERE r.event_id = e.id AND r.occurrence_start = e.occurrence_start) +
                  (SELECT COUNT(*) FROM event_bracket_guests g
                   WHERE g.event_id = e.id AND g.occurrence_start = e.occurrence_start)
                )::INTEGER
              ) AS bracket_participant_count,
              EXISTS (
                SELECT 1 FROM event_rsvps r
                WHERE r.event_id = e.id AND r.occurrence_start = e.occurrence_start AND r.user_id = $1
              ) AS reserved
       FROM occurrences e
       LEFT JOIN tournament_brackets b
         ON b.event_id = e.id AND b.occurrence_start = e.occurrence_start
       ORDER BY e.occurrence_start, e.id`,
      [userId, monthStart],
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
        title: string;
        starts_at: Date;
        capacity: number | null;
        rsvp_open: boolean;
        bracket_enabled: boolean;
        recurrence: EventRecord['recurrence'];
        recurrence_until: string | null;
        active: boolean;
      }>(
        `SELECT title, starts_at, capacity, rsvp_open, bracket_enabled, recurrence,
                recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event || !event.active) throw new StoreError('event_not_found', 'Event not found.');
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);

      const cutoff = await client.query<QueryResultRow & { open: boolean }>(
        'SELECT $1::TIMESTAMPTZ > NOW() AS open',
        [occurrenceStart],
      );
      if (!cutoff.rows[0].open) {
        throw new StoreError('rsvp_closed', 'RSVPs are closed for this event occurrence.');
      }

      const existing = await client.query(
        'SELECT 1 FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2 AND user_id = $3',
        [eventId, occurrenceStart, userId],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return 'already_rsvped';
      }
      if (!event.bracket_enabled && !event.rsvp_open) {
        throw new StoreError('rsvp_closed', 'RSVPs are closed for this event.');
      }

      const count = await client.query<QueryResultRow & { total: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2) +
           (SELECT COUNT(*) FROM event_bracket_guests WHERE event_id = $1 AND occurrence_start = $2)
         )::TEXT AS total`,
        [eventId, occurrenceStart],
      );
      if (event.capacity !== null && Number(count.rows[0].total) >= event.capacity) {
        throw new StoreError('event_full', 'This event has reached capacity.');
      }

      await client.query(
        'INSERT INTO event_rsvps (event_id, occurrence_start, user_id) VALUES ($1, $2, $3)',
        [eventId, occurrenceStart, userId],
      );
      await this.createNotification(client, {
        userId,
        category: 'rsvp',
        type: 'rsvp_confirmed',
        title: 'RSVP confirmed',
        body: `You're on the guest list for ${event.title}.`,
        data: { screen: 'Events', eventId, occurrenceStart },
        dedupeKey: `rsvp-confirmed:${randomUUID()}`,
      });
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event) throw new StoreError('event_not_found', 'Event not found.');
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);
      if (event.bracket_enabled) {
        const cutoff = await client.query<QueryResultRow & { open: boolean }>(
          'SELECT $1::TIMESTAMPTZ > NOW() AS open',
          [occurrenceStart],
        );
        if (!cutoff.rows[0].open) {
          throw new StoreError('rsvp_closed', 'RSVPs are closed for this event occurrence.');
        }
      }
      const result = await client.query(
        'DELETE FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2 AND user_id = $3',
        [eventId, occurrenceStart, userId],
      );
      if (result.rowCount) {
        await this.createNotification(client, {
          userId,
          category: 'rsvp',
          type: 'rsvp_cancelled',
          title: 'RSVP canceled',
          body: `Your RSVP for ${event.title} was canceled.`,
          data: { screen: 'Events', eventId, occurrenceStart },
          dedupeKey: `rsvp-cancelled:${randomUUID()}`,
        });
      }
      await client.query('COMMIT');
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeDueBrackets(): Promise<void> {
    const result = await this.pool.query<QueryResultRow & {
      event_id: string;
      occurrence_start: Date;
    }>(
      `WITH clock AS (
         SELECT NOW() AS now_utc, NOW() AT TIME ZONE 'America/New_York' AS now_local
       ), anchors AS (
         SELECT e.id, e.starts_at, e.recurrence, e.recurrence_until,
                e.starts_at AT TIME ZONE 'America/New_York' AS local_start,
                clock.now_utc, clock.now_local,
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
                    )
                  )
                  ELSE 0
                END AS last_index
         FROM events e
         CROSS JOIN clock
         WHERE e.active = TRUE AND e.bracket_enabled = TRUE
       ), occurrences AS (
         SELECT anchors.id AS event_id,
                (
                  local_start + CASE recurrence
                    WHEN 'weekly' THEN indices.n * INTERVAL '1 week'
                    WHEN 'monthly' THEN indices.n * INTERVAL '1 month'
                    ELSE INTERVAL '0'
                  END
                ) AT TIME ZONE 'America/New_York' AS occurrence_start,
                anchors.recurrence_until
         FROM anchors
         CROSS JOIN LATERAL generate_series(0, last_index) AS indices(n)
       )
       SELECT o.event_id, o.occurrence_start
       FROM occurrences o
       WHERE o.occurrence_start <= NOW()
         AND (
           o.recurrence_until IS NULL
           OR (o.occurrence_start AT TIME ZONE 'America/New_York')::DATE <= o.recurrence_until
         )
         AND NOT EXISTS (
           SELECT 1 FROM tournament_brackets b
           WHERE b.event_id = o.event_id AND b.occurrence_start = o.occurrence_start
         )
         AND (
           EXISTS (
             SELECT 1 FROM event_rsvps r
             WHERE r.event_id = o.event_id AND r.occurrence_start = o.occurrence_start
           )
           OR EXISTS (
             SELECT 1 FROM event_bracket_guests g
             WHERE g.event_id = o.event_id AND g.occurrence_start = o.occurrence_start
           )
         )
       ORDER BY o.occurrence_start, o.event_id`,
    );
    for (const row of result.rows) {
      await this.drawEventBracket(null, row.event_id, row.occurrence_start.toISOString());
    }
  }

  async getEventBracket(eventId: string, occurrenceStart: string): Promise<TournamentBracket> {
    const eventResult = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
              recurrence, recurrence_until::TEXT AS recurrence_until, active
       FROM events WHERE id = $1`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event) throw new StoreError('event_not_found', 'Event not found.');
    if (!event.bracket_enabled) {
      throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
    }
    await this.assertEventOccurrence(eventId, occurrenceStart, event, this.pool);

    const [bracketResult, participantResult, cutoffResult] = await Promise.all([
      this.pool.query<QueryResultRow & {
        status: 'drawn' | 'completed';
        randomized_at: Date;
        champion_entrant_id: string | null;
      }>(
        `SELECT status, randomized_at, champion_entrant_id
         FROM tournament_brackets
         WHERE event_id = $1 AND occurrence_start = $2`,
        [eventId, occurrenceStart],
      ),
      this.pool.query<QueryResultRow & { total: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2) +
           (SELECT COUNT(*) FROM event_bracket_guests WHERE event_id = $1 AND occurrence_start = $2)
         )::TEXT AS total`,
        [eventId, occurrenceStart],
      ),
      this.pool.query<QueryResultRow & { passed: boolean }>(
        'SELECT $1::TIMESTAMPTZ <= NOW() AS passed',
        [occurrenceStart],
      ),
    ]);
    const bracket = bracketResult.rows[0];
    const cutoffPassed = cutoffResult.rows[0].passed;

    let entrants: TournamentBracket['entrants'] = [];
    const rounds: BracketMatch[][] = [];
    if (bracket) {
      const entrantResult = await this.pool.query<BracketEntrantRow>(
        `SELECT e.entrant_id, e.user_id, e.display_name AS name, e.status
         FROM tournament_bracket_entrants e
         WHERE e.event_id = $1 AND e.occurrence_start = $2
         ORDER BY e.created_at, e.display_name, e.entrant_id`,
        [eventId, occurrenceStart],
      );
      entrants = entrantResult.rows.map(entrant => ({
        entrantId: entrant.entrant_id,
        userId: entrant.user_id,
        name: entrant.name,
        status: entrant.status ?? 'active',
      }));

      const matchResult = await this.pool.query<BracketMatchRow>(
        `SELECT m.id, m.round_number, m.match_number,
                m.player_one_entrant_id, p1.display_name AS player_one_name,
                p1.user_id AS player_one_user_id,
                m.player_two_entrant_id, p2.display_name AS player_two_name,
                p2.user_id AS player_two_user_id,
                m.winner_entrant_id
         FROM tournament_bracket_matches m
         LEFT JOIN tournament_bracket_entrants p1
           ON p1.event_id = m.event_id AND p1.occurrence_start = m.occurrence_start
           AND p1.entrant_id = m.player_one_entrant_id
         LEFT JOIN tournament_bracket_entrants p2
           ON p2.event_id = m.event_id AND p2.occurrence_start = m.occurrence_start
           AND p2.entrant_id = m.player_two_entrant_id
         WHERE m.event_id = $1 AND m.occurrence_start = $2
         ORDER BY m.round_number, m.match_number`,
        [eventId, occurrenceStart],
      );
      for (const match of matchResult.rows) {
        const round = rounds[match.round_number - 1] ?? (rounds[match.round_number - 1] = []);
        round.push({
          id: match.id,
          roundNumber: match.round_number,
          matchNumber: match.match_number,
          playerOne: match.player_one_entrant_id && match.player_one_name
            ? {
              entrantId: match.player_one_entrant_id,
              userId: match.player_one_user_id,
              name: match.player_one_name,
            }
            : null,
          playerTwo: match.player_two_entrant_id && match.player_two_name
            ? {
              entrantId: match.player_two_entrant_id,
              userId: match.player_two_user_id,
              name: match.player_two_name,
            }
            : null,
          winnerEntrantId: match.winner_entrant_id,
        });
      }
    }

    return {
      eventId,
      occurrenceStart: new Date(occurrenceStart).toISOString(),
      cutoffAt: new Date(occurrenceStart).toISOString(),
      participantCount: bracket ? entrants.length : Number(participantResult.rows[0].total),
      status: cutoffPassed ? bracket?.status ?? 'not_started' : 'not_started',
      randomizedAt: cutoffPassed ? bracket?.randomized_at.toISOString() ?? null : null,
      entrants: cutoffPassed ? entrants : [],
      rounds: cutoffPassed ? rounds : [],
      championEntrantId: cutoffPassed ? bracket?.champion_entrant_id ?? null : null,
    };
  }

  async drawEventBracket(
    actorId: string | null,
    eventId: string,
    occurrenceStart: string,
  ): Promise<TournamentBracket> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event || !event.active) throw new StoreError('event_not_found', 'Event not found.');
      if (!event.bracket_enabled) {
        throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
      }
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);

      const cutoffResult = await client.query<QueryResultRow & { passed: boolean }>(
        'SELECT $1::TIMESTAMPTZ <= NOW() AS passed',
        [occurrenceStart],
      );
      if (!cutoffResult.rows[0].passed) {
        throw new StoreError('bracket_cutoff_open_conflict', 'The bracket is randomized when RSVPs close at event start.');
      }

      const existing = await client.query<QueryResultRow>(
        `SELECT 1 FROM tournament_brackets
         WHERE event_id = $1 AND occurrence_start = $2 FOR UPDATE`,
        [eventId, occurrenceStart],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
      } else {
        const entrantResult = await client.query<QueryResultRow & {
          entrant_id: string;
          user_id: string | null;
          name: string;
        }>(
          `SELECT r.user_id AS entrant_id, r.user_id, u.name, r.created_at
           FROM event_rsvps r
           JOIN users u ON u.id = r.user_id
           WHERE r.event_id = $1 AND r.occurrence_start = $2
           UNION ALL
           SELECT g.id AS entrant_id, NULL::UUID AS user_id, g.name, g.created_at
           FROM event_bracket_guests g
           WHERE g.event_id = $1 AND g.occurrence_start = $2
           ORDER BY created_at, entrant_id`,
          [eventId, occurrenceStart],
        );
        if (entrantResult.rowCount === 0) {
          throw new StoreError('bracket_empty_conflict', 'At least one participant is required to create a bracket.');
        }
        const entrantIds = entrantResult.rows.map(row => row.entrant_id);
        const championId = entrantIds.length === 1 ? entrantIds[0] : null;
        await client.query(
          `INSERT INTO tournament_brackets
             (event_id, occurrence_start, status, created_by, champion_entrant_id, draw_source)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            eventId, occurrenceStart, entrantIds.length === 1 ? 'completed' : 'drawn',
            actorId, championId, actorId === null ? 'system' : 'staff',
          ],
        );
        for (const entrant of entrantResult.rows) {
          await client.query(
            `INSERT INTO tournament_bracket_entrants
               (entrant_id, event_id, occurrence_start, user_id, display_name, status)
             VALUES ($1, $2, $3, $4, $5, 'active')`,
            [entrant.entrant_id, eventId, occurrenceStart, entrant.user_id, entrant.name],
          );
        }

        if (entrantIds.length > 1) {
          const matches = makeBracketMatches(entrantIds);
          for (const match of [...matches].sort((a, b) => b.roundNumber - a.roundNumber || a.matchNumber - b.matchNumber)) {
            await client.query(
              `INSERT INTO tournament_bracket_matches
                 (id, event_id, occurrence_start, round_number, match_number,
                  player_one_entrant_id, player_two_entrant_id, winner_entrant_id, next_match_id, next_slot)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                match.id, eventId, occurrenceStart, match.roundNumber, match.matchNumber,
                match.playerOneId, match.playerTwoId, match.winnerEntrantId, match.nextMatchId, match.nextSlot,
              ],
            );
          }
        }
        await this.writeAudit(client, actorId, 'tournament.bracket_draw', 'event_occurrence',
          `${eventId}:${new Date(occurrenceStart).toISOString()}`, {
            entrants: entrantIds.length,
            source: actorId === null ? 'system' : 'staff',
          });
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getEventBracket(eventId, occurrenceStart);
  }

  async listBracketGuests(eventId: string, occurrenceStart: string): Promise<BracketGuest[]> {
    const eventResult = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
              recurrence, recurrence_until::TEXT AS recurrence_until, active
       FROM events WHERE id = $1`,
      [eventId],
    );
    const event = eventResult.rows[0];
    if (!event) throw new StoreError('event_not_found', 'Event not found.');
    if (!event.bracket_enabled) {
      throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
    }
    await this.assertEventOccurrence(eventId, occurrenceStart, event, this.pool);
    const result = await this.pool.query<QueryResultRow & {
      id: string;
      name: string;
      created_at: Date;
    }>(
      `SELECT id, name, created_at FROM event_bracket_guests
       WHERE event_id = $1 AND occurrence_start = $2
       ORDER BY created_at, id`,
      [eventId, occurrenceStart],
    );
    return result.rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at.toISOString() }));
  }

  async addBracketGuest(
    actorId: string,
    eventId: string,
    occurrenceStart: string,
    name: string,
  ): Promise<BracketGuest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event || !event.active) throw new StoreError('event_not_found', 'Event not found.');
      if (!event.bracket_enabled) {
        throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
      }
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);
      const cutoff = await client.query<QueryResultRow & { open: boolean }>(
        'SELECT $1::TIMESTAMPTZ > NOW() AS open',
        [occurrenceStart],
      );
      if (!cutoff.rows[0].open) {
        throw new StoreError('rsvp_closed', 'Guest entries are closed for this event occurrence.');
      }

      const count = await client.query<QueryResultRow & { total: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1 AND occurrence_start = $2) +
           (SELECT COUNT(*) FROM event_bracket_guests WHERE event_id = $1 AND occurrence_start = $2)
         )::TEXT AS total`,
        [eventId, occurrenceStart],
      );
      if (event.capacity !== null && Number(count.rows[0].total) >= event.capacity) {
        throw new StoreError('event_full', 'This event has reached capacity.');
      }
      const result = await client.query<QueryResultRow & {
        id: string;
        name: string;
        created_at: Date;
      }>(
        `INSERT INTO event_bracket_guests (event_id, occurrence_start, name, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, created_at`,
        [eventId, occurrenceStart, name, actorId],
      );
      const guest = {
        id: result.rows[0].id,
        name: result.rows[0].name,
        createdAt: result.rows[0].created_at.toISOString(),
      };
      await this.writeAudit(client, actorId, 'tournament.guest_add', 'event_occurrence',
        `${eventId}:${new Date(occurrenceStart).toISOString()}`, { guestId: guest.id, name: guest.name });
      await client.query('COMMIT');
      return guest;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async removeBracketGuest(
    actorId: string,
    eventId: string,
    occurrenceStart: string,
    guestId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event || !event.active) throw new StoreError('event_not_found', 'Event not found.');
      if (!event.bracket_enabled) {
        throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
      }
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);
      const cutoff = await client.query<QueryResultRow & { open: boolean }>(
        'SELECT $1::TIMESTAMPTZ > NOW() AS open',
        [occurrenceStart],
      );
      if (!cutoff.rows[0].open) {
        throw new StoreError('rsvp_closed', 'Guest entries are closed for this event occurrence.');
      }
      const result = await client.query(
        `DELETE FROM event_bracket_guests
         WHERE id = $1 AND event_id = $2 AND occurrence_start = $3`,
        [guestId, eventId, occurrenceStart],
      );
      if (!result.rowCount) throw new StoreError('bracket_guest_not_found', 'Guest entry not found.');
      await this.writeAudit(client, actorId, 'tournament.guest_remove', 'event_occurrence',
        `${eventId}:${new Date(occurrenceStart).toISOString()}`, { guestId });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordBracketWinner(
    actorId: string,
    eventId: string,
    occurrenceStart: string,
    matchId: string,
    winnerEntrantId: string,
  ): Promise<TournamentBracket> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<EventRow>(
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event) throw new StoreError('event_not_found', 'Event not found.');
      if (!event.bracket_enabled) {
        throw new StoreError('bracket_disabled_conflict', 'Tournament brackets are disabled for this event.');
      }
      await this.assertEventOccurrence(eventId, occurrenceStart, event, client);

      const bracketResult = await client.query<QueryResultRow & { status: 'drawn' | 'completed' }>(
        `SELECT status FROM tournament_brackets
         WHERE event_id = $1 AND occurrence_start = $2 FOR UPDATE`,
        [eventId, occurrenceStart],
      );
      const bracket = bracketResult.rows[0];
      if (!bracket) throw new StoreError('bracket_not_found', 'The bracket has not been drawn.');

      const matchResult = await client.query<QueryResultRow & {
        player_one_entrant_id: string | null;
        player_two_entrant_id: string | null;
        winner_entrant_id: string | null;
        next_match_id: string | null;
        next_slot: 'one' | 'two' | null;
      }>(
        `SELECT player_one_entrant_id, player_two_entrant_id, winner_entrant_id, next_match_id, next_slot
         FROM tournament_bracket_matches
         WHERE id = $1 AND event_id = $2 AND occurrence_start = $3
         FOR UPDATE`,
        [matchId, eventId, occurrenceStart],
      );
      const match = matchResult.rows[0];
      if (!match) throw new StoreError('bracket_match_not_found', 'Bracket match not found.');
      if (match.winner_entrant_id !== winnerEntrantId) {
        if (bracket.status === 'completed') {
          throw new StoreError('bracket_completed_conflict', 'The bracket is already complete.');
        }
        if (!match.player_one_entrant_id || !match.player_two_entrant_id) {
          throw new StoreError('bracket_match_not_ready_conflict', 'Both players must be known before recording a winner.');
        }
        if (winnerEntrantId !== match.player_one_entrant_id && winnerEntrantId !== match.player_two_entrant_id) {
          throw new StoreError('bracket_winner_invalid', 'The winner must be one of the players in this match.');
        }
        if (match.winner_entrant_id) {
          throw new StoreError('bracket_match_completed_conflict', 'This match already has a recorded winner.');
        }

        await client.query(
          `UPDATE tournament_bracket_matches
           SET winner_entrant_id = $4
           WHERE id = $1 AND event_id = $2 AND occurrence_start = $3`,
          [matchId, eventId, occurrenceStart, winnerEntrantId],
        );
        if (match.next_match_id && match.next_slot) {
          const column = match.next_slot === 'one' ? 'player_one_entrant_id' : 'player_two_entrant_id';
          const advanceResult = await client.query(
            `UPDATE tournament_bracket_matches
             SET ${column} = $4
             WHERE id = $1 AND event_id = $2 AND occurrence_start = $3
               AND (${column} IS NULL OR ${column} = $4)`,
            [match.next_match_id, eventId, occurrenceStart, winnerEntrantId],
          );
          if (!advanceResult.rowCount) {
            throw new StoreError('bracket_advancement_conflict', 'The winner could not be advanced to the next round.');
          }
        } else {
          await client.query(
            `UPDATE tournament_brackets
             SET status = 'completed', champion_entrant_id = $3
             WHERE event_id = $1 AND occurrence_start = $2`,
            [eventId, occurrenceStart, winnerEntrantId],
          );
        }
        await this.writeAudit(
          client,
          actorId,
          'tournament.match_winner',
          'bracket_match',
          matchId,
          { winnerEntrantId },
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getEventBracket(eventId, occurrenceStart);
  }

  async listEventAttendees(
    eventId: string,
    occurrenceStart: string,
    limit: number,
    offset: number,
  ): Promise<{ event: EventRecord; total: number; attendees: EventAttendee[] }> {
    const eventResult = await this.pool.query<EventRow>(
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
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
      `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
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
           (id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled, recurrence, recurrence_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [
          input.id, input.title, input.startsAt, input.description,
          input.tag, input.capacity, input.rsvpOpen, input.bracketEnabled,
          input.recurrence, input.recurrenceUntil,
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
        `SELECT id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                recurrence, recurrence_until::TEXT AS recurrence_until, active
         FROM events WHERE id = $1 FOR UPDATE`,
        [eventId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new StoreError('event_not_found', 'Event not found.');
      const rsvpCount = await client.query<QueryResultRow & { total: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM event_rsvps WHERE event_id = $1) +
           (SELECT COUNT(*) FROM event_bracket_guests WHERE event_id = $1)
         )::TEXT AS total`,
        [eventId],
      );
      if (Number(rsvpCount.rows[0].total) > 0 &&
        (current.starts_at.getTime() !== new Date(input.startsAt).getTime() ||
          current.recurrence !== input.recurrence ||
          current.recurrence_until !== input.recurrenceUntil)) {
        throw new StoreError(
          'event_schedule_conflict',
          'The event schedule cannot change after attendees or bracket guests have registered. Archive this series and create a new one.',
        );
      }
      const overCapacity = input.capacity === null ? false : (await client.query<QueryResultRow & { over_capacity: boolean }>(
        `WITH participants AS (
           SELECT event_id, occurrence_start FROM event_rsvps WHERE event_id = $1
           UNION ALL
           SELECT event_id, occurrence_start FROM event_bracket_guests WHERE event_id = $1
         )
         SELECT EXISTS (
           SELECT 1 FROM participants
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
             rsvp_open = $7, bracket_enabled = $8, recurrence = $9, recurrence_until = $10,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [
          eventId, input.title, input.startsAt, input.description, input.tag,
          input.capacity, input.rsvpOpen, input.bracketEnabled, input.recurrence, input.recurrenceUntil,
        ],
      );
      const event = toEvent(result.rows[0]);
      const eventChangesAffectMembers = current.title !== event.title ||
        current.starts_at.getTime() !== new Date(event.startsAt).getTime() ||
        current.description !== event.description || current.tag !== event.tag;
      if (eventChangesAffectMembers) {
        const attendees = await client.query<QueryResultRow & {
          user_id: string;
          occurrence_start: Date;
        }>(
          `SELECT DISTINCT user_id, occurrence_start FROM event_rsvps
           WHERE event_id = $1 AND occurrence_start > NOW()`,
          [eventId],
        );
        const operationId = randomUUID();
        for (const attendee of attendees.rows) {
          const occurrenceStart = attendee.occurrence_start.toISOString();
          await this.createNotification(client, {
            userId: attendee.user_id,
            category: 'event',
            type: 'event_changed',
            title: 'Event updated',
            body: `${event.title} has changed. Check the event details for the latest information.`,
            data: { screen: 'Events', eventId, occurrenceStart },
            dedupeKey: `event-update:${eventId}:${occurrenceStart}:${operationId}`,
          });
        }
      }
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
      const attendees = await client.query<QueryResultRow & {
        user_id: string;
        occurrence_start: Date;
      }>(
        `SELECT DISTINCT r.user_id, r.occurrence_start
         FROM event_rsvps r JOIN events e ON e.id = r.event_id
         WHERE r.event_id = $1 AND r.occurrence_start > NOW() AND e.active = TRUE`,
        [eventId],
      );
      const result = await client.query<EventRow>(
        `UPDATE events SET active = FALSE, rsvp_open = FALSE, updated_at = NOW()
         WHERE id = $1 AND active = TRUE
         RETURNING id, title, starts_at, description, tag, capacity, rsvp_open, bracket_enabled,
                   recurrence, recurrence_until::TEXT AS recurrence_until, active`,
        [eventId],
      );
      const event = result.rows[0];
      if (!event) throw new StoreError('event_not_found', 'Event not found or already archived.');
      const operationId = randomUUID();
      for (const attendee of attendees.rows) {
        const occurrenceStart = attendee.occurrence_start.toISOString();
        await this.createNotification(client, {
          userId: attendee.user_id,
          category: 'event',
          type: 'event_cancelled',
          title: 'Event canceled',
          body: `${event.title} has been canceled.`,
          data: { screen: 'Events', eventId, occurrenceStart },
          dedupeKey: `event-cancelled:${eventId}:${occurrenceStart}:${operationId}`,
        });
      }
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
    actorId: string | null,
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

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Account, RedemptionResult, Reward, UserRecord } from './domain.js';
import type { EmailTokenPurpose, Store } from './store.js';

type UserRow = QueryResultRow & {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
};

type AccountRow = QueryResultRow & {
  id: string;
  name: string;
  email: string;
  reward_points: string | number;
};

type RewardRow = QueryResultRow & {
  id: string;
  name: string;
  points_cost: number;
  icon: string;
};

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
  };
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    rewardPoints: Number(row.reward_points),
  };
}

function toReward(row: RewardRow): Reward {
  return { id: row.id, name: row.name, pointsCost: row.points_cost, icon: row.icon };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function accountByUserId(client: Pool | PoolClient, userId: string): Promise<Account> {
  const result = await client.query<AccountRow>(
    `SELECT u.id, u.name, u.email, COALESCE(SUM(l.delta), 0)::INTEGER AS reward_points
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
         RETURNING id, name, email, password_hash, email_verified_at`,
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
      `SELECT id, name, email, password_hash, email_verified_at
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
}

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import type { Account, RedemptionResult, Reward, UserRecord } from '../src/domain.js';
import type { AppConfig } from '../src/config.js';
import type { EmailSender } from '../src/email.js';
import type { EmailTokenPurpose, Store } from '../src/store.js';
import { hashEmailCode, hashOpaqueToken } from '../src/crypto.js';

type EmailToken = {
  userId: string;
  purpose: EmailTokenPurpose;
  hash: string;
  expiresAt: Date;
  consumed: boolean;
};

type MemorySession = {
  userId: string;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

class MemoryStore implements Store {
  readonly users = new Map<string, UserRecord>();
  readonly emailTokens = new Map<string, EmailToken>();
  readonly sessions = new Map<string, MemorySession>();
  readonly balances = new Map<string, number>();
  readonly redemptions = new Map<string, Extract<RedemptionResult, { kind: 'redeemed' }>>();
  readonly rewards: Reward[] = [
    { id: 'coffee', name: 'A coffee on us', pointsCost: 100, icon: '☕' },
    { id: 'pastry', name: 'Your favorite pastry', pointsCost: 150, icon: '🥐' },
    { id: 'lunch', name: 'Lunch, with love', pointsCost: 250, icon: '🥗' },
  ];

  async createUser(id: string, name: string, email: string, passwordHash: string): Promise<UserRecord | null> {
    if (this.users.has(email)) return null;
    const user = { id, name, email, passwordHash, emailVerifiedAt: null };
    this.users.set(email, user);
    this.balances.set(id, 0);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null;
  }

  async issueEmailToken(userId: string, purpose: EmailTokenPurpose, tokenHash: string, expiresAt: Date): Promise<void> {
    const key = `${userId}:${purpose}`;
    this.emailTokens.set(key, { userId, purpose, hash: tokenHash, expiresAt, consumed: false });
  }

  async verifyEmail(email: string, tokenHash: string): Promise<boolean> {
    const user = this.users.get(email);
    const token = user && this.emailTokens.get(`${user.id}:verify_email`);
    if (!user || !token || token.hash !== tokenHash || token.expiresAt <= new Date() || token.consumed) return false;
    token.consumed = true;
    user.emailVerifiedAt = new Date();
    return true;
  }

  async resetPassword(email: string, tokenHash: string, passwordHash: string): Promise<boolean> {
    const user = this.users.get(email);
    const token = user && this.emailTokens.get(`${user.id}:reset_password`);
    if (!user || !token || token.hash !== tokenHash || token.expiresAt <= new Date() || token.consumed) return false;
    token.consumed = true;
    user.passwordHash = passwordHash;
    for (const [key, session] of this.sessions) {
      if (session.userId === user.id) this.sessions.delete(key);
    }
    return true;
  }

  async createSession(
    _id: string,
    userId: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account> {
    this.sessions.set(refreshTokenHash, {
      userId,
      accessHash: accessTokenHash,
      refreshHash: refreshTokenHash,
      accessExpiresAt,
      refreshExpiresAt,
    });
    return this.account(userId);
  }

  async findAccountByAccessTokenHash(accessTokenHash: string): Promise<Account | null> {
    const session = [...this.sessions.values()].find(item =>
      item.accessHash === accessTokenHash && item.accessExpiresAt > new Date());
    return session ? this.account(session.userId) : null;
  }

  async rotateSession(
    oldRefreshTokenHash: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account | null> {
    const session = this.sessions.get(oldRefreshTokenHash);
    if (!session || session.refreshExpiresAt <= new Date()) return null;
    this.sessions.delete(oldRefreshTokenHash);
    session.accessHash = accessTokenHash;
    session.refreshHash = refreshTokenHash;
    session.accessExpiresAt = accessExpiresAt;
    session.refreshExpiresAt = refreshExpiresAt;
    this.sessions.set(refreshTokenHash, session);
    return this.account(session.userId);
  }

  async revokeSession(refreshTokenHash: string): Promise<void> {
    this.sessions.delete(refreshTokenHash);
  }

  async listRewards(): Promise<Reward[]> {
    return this.rewards;
  }

  async redeem(userId: string, rewardId: string, idempotencyKey: string): Promise<RedemptionResult> {
    const key = `${userId}:${idempotencyKey}`;
    const existing = this.redemptions.get(key);
    if (existing) return { ...existing, alreadyApplied: true };
    const reward = this.rewards.find(item => item.id === rewardId);
    if (!reward) return { kind: 'reward_unavailable' };
    const balance = this.balances.get(userId) ?? 0;
    if (balance < reward.pointsCost) return { kind: 'insufficient_points', balance };
    const result = {
      kind: 'redeemed' as const,
      redemptionId: `redemption-${this.redemptions.size + 1}`,
      reward,
      balance: balance - reward.pointsCost,
      alreadyApplied: false,
    };
    this.balances.set(userId, result.balance);
    this.redemptions.set(key, result);
    return result;
  }

  private account(userId: string): Account {
    const user = [...this.users.values()].find(item => item.id === userId);
    if (!user) throw new Error('Memory store user not found.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      rewardPoints: this.balances.get(userId) ?? 0,
    };
  }
}

const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  databaseUrl: 'postgres://unused',
  tokenHashSecret: 'test-token-hash-secret-at-least-32-characters',
  allowedOrigins: ['http://localhost:8081'],
  accessTokenMinutes: 15,
  refreshTokenDays: 30,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPassword: '',
  emailFrom: 'test@example.com',
  sessionCookieName: 'gf_refresh',
};

const store = new MemoryStore();
const sentCodes = new Map<'verify_email' | 'reset_password', string>();
const emailSender: EmailSender = {
  async sendVerificationCode(_email, code) {
    sentCodes.set('verify_email', code);
  },
  async sendPasswordResetCode(_email, code) {
    sentCodes.set('reset_password', code);
  },
};
const app = createApp({ config, store, emailSender });

before(async () => {
  await app.ready();
});

after(async () => {
  await app.close();
});

test('account verification, login, reset, and session revocation work', async () => {
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: 'Member', email: 'member@example.com', password: 'StrongPass!123' },
  });
  assert.equal(registration.statusCode, 202);
  assert.ok(sentCodes.get('verify_email'));
  assert.equal(store.users.size, 1);
  assert.equal([...store.users.values()][0].passwordHash.includes('StrongPass!123'), false);

  const wrongCredentials = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'member@example.com', password: 'WrongPass!123' },
  });
  assert.equal(wrongCredentials.statusCode, 401);

  const verification = await app.inject({
    method: 'POST',
    url: '/api/auth/verify-email',
    payload: { email: 'member@example.com', code: sentCodes.get('verify_email') },
  });
  assert.equal(verification.statusCode, 200);

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-session-transport': 'native' },
    payload: { email: 'member@example.com', password: 'StrongPass!123' },
  });
  assert.equal(login.statusCode, 200);
  const session = login.json<{ accessToken: string; refreshToken: string; account: Account }>();
  assert.equal(session.account.rewardPoints, 0);
  assert.ok(session.refreshToken);
  assert.equal(JSON.stringify(session).includes('passwordHash'), false);

  const profile = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(profile.statusCode, 200);

  store.balances.set(session.account.id, 400);
  const redemption = await app.inject({
    method: 'POST',
    url: '/api/redemptions',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'idempotency-key': 'member-lunch-001',
    },
    payload: { rewardId: 'lunch' },
  });
  assert.equal(redemption.statusCode, 201);
  assert.equal(redemption.json<{ rewardPoints: number }>().rewardPoints, 150);

  const repeatedRedemption = await app.inject({
    method: 'POST',
    url: '/api/redemptions',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'idempotency-key': 'member-lunch-001',
    },
    payload: { rewardId: 'lunch' },
  });
  assert.equal(repeatedRedemption.statusCode, 200);
  assert.equal(repeatedRedemption.json<{ rewardPoints: number }>().rewardPoints, 150);

  const resetRequest = await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/request',
    payload: { email: 'member@example.com' },
  });
  assert.equal(resetRequest.statusCode, 200);
  const reset = await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/confirm',
    payload: {
      email: 'member@example.com',
      code: sentCodes.get('reset_password'),
      newPassword: 'EvenStronger!456',
    },
  });
  assert.equal(reset.statusCode, 200);
  const revokedProfile = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(revokedProfile.statusCode, 401);
});

test('cookie session transport requires an allowed browser origin', async () => {
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: { 'x-session-transport': 'cookie', origin: 'https://attacker.example' },
  });
  assert.equal(rejected.statusCode, 403);
});

test('token hashes are not the raw session token', () => {
  assert.notEqual(hashOpaqueToken('raw-session-token'), 'raw-session-token');
});

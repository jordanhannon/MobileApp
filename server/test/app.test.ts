import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import type {
  Account, AdminReward, AdminUser, EventAttendee, EventInput, EventRecord, MemberEvent,
  PointsLedgerEntry, PointsSummary, RedemptionResult, Reward, SocialIdentityInput,
  SocialIdentityProvider, SocialIdentityResult, UserRecord, UserRole,
} from '../src/domain.js';
import { StoreError } from '../src/domain.js';
import type { AppConfig } from '../src/config.js';
import type { EmailSender } from '../src/email.js';
import type { EmailTokenPurpose, Store } from '../src/store.js';
import { hashEmailCode, hashOpaqueToken, normalizeEmail } from '../src/crypto.js';
import { InvalidSocialTokenError } from '../src/socialAuth.js';
import type { SocialTokenVerifier, VerifiedSocialIdentity } from '../src/socialAuth.js';

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
  readonly socialNonces = new Map<string, { expiresAt: Date; consumed: boolean }>();
  readonly socialIdentities = new Map<string, string>();
  readonly socialProviderByUser = new Map<string, string>();
  readonly emailTokens = new Map<string, EmailToken>();
  readonly sessions = new Map<string, MemorySession>();
  readonly balances = new Map<string, number>();
  readonly redemptions = new Map<string, Extract<RedemptionResult, { kind: 'redeemed' }>>();
  readonly rsvps = new Map<string, Set<string>>();
  readonly audit: Array<{ actorId: string; action: string; targetId: string }> = [];
  readonly events: EventRecord[] = [
    {
      id: 'tasting',
      title: 'A taste of the season',
      startsAt: '2026-11-14T16:00:00.000Z',
      description: 'Meet our seasonal favorites with a tasting made for our members.',
      tag: 'MEMBER EXCLUSIVE',
      capacity: null,
      rsvpOpen: true,
      recurrence: 'none',
      recurrenceUntil: null,
      active: true,
    },
  ];
  readonly adminRewards = new Map<string, AdminReward>(
    [
      { id: 'coffee', name: 'A coffee on us', pointsCost: 100, icon: '☕', active: true },
      { id: 'pastry', name: 'Your favorite pastry', pointsCost: 150, icon: '🥐', active: true },
      { id: 'lunch', name: 'Lunch, with love', pointsCost: 250, icon: '🥗', active: true },
    ].map(reward => [reward.id, reward]),
  );
  readonly rewards: Reward[] = [
    { id: 'coffee', name: 'A coffee on us', pointsCost: 100, icon: '☕' },
    { id: 'pastry', name: 'Your favorite pastry', pointsCost: 150, icon: '🥐' },
    { id: 'lunch', name: 'Lunch, with love', pointsCost: 250, icon: '🥗' },
  ];

  async createUser(id: string, name: string, email: string, passwordHash: string): Promise<UserRecord | null> {
    if (this.users.has(email)) return null;
    const user = { id, name, email, passwordHash, emailVerifiedAt: null, role: 'member' as UserRole };
    this.users.set(email, user);
    this.balances.set(id, 0);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null;
  }

  async issueSocialNonce(
    provider: SocialIdentityProvider,
    nonceHash: string,
    expiresAt: Date,
  ): Promise<void> {
    this.socialNonces.set(`${provider}:${nonceHash}`, { expiresAt, consumed: false });
  }

  async resolveSocialIdentity(input: SocialIdentityInput): Promise<SocialIdentityResult> {
    const nonceKey = `${input.provider}:${input.nonceHash}`;
    const challenge = this.socialNonces.get(nonceKey);
    if (!challenge || challenge.consumed || challenge.expiresAt <= new Date()) {
      throw new StoreError('social_nonce_invalid', 'Sign-in request expired. Please try again.');
    }

    const identityKey = `${input.provider}:${input.subject}`;
    const existingId = this.socialIdentities.get(identityKey);
    if (existingId) {
      challenge.consumed = true;
      const user = [...this.users.values()].find(item => item.id === existingId);
      if (!user) throw new Error('Memory store social identity user not found.');
      return { kind: 'authenticated', user };
    }
    if (!input.email || !input.emailVerified) {
      throw new StoreError('social_email_unverified', 'A verified email address is required for this sign-in method.');
    }

    const email = normalizeEmail(input.email);
    let user = this.users.get(email);
    if (user) {
      user.emailVerifiedAt ??= new Date();
    } else {
      const name = input.name?.trim();
      if (!name) return { kind: 'profile_required' };
      user = {
        id: input.id,
        name,
        email,
        passwordHash: null,
        emailVerifiedAt: new Date(),
        role: 'member',
      };
      this.users.set(email, user);
      this.balances.set(user.id, 0);
    }

    const providerKey = `${user.id}:${input.provider}`;
    const linkedIdentity = this.socialProviderByUser.get(providerKey);
    if (linkedIdentity && linkedIdentity !== identityKey) {
      throw new StoreError('social_identity_conflict', 'This sign-in method is already linked to another account.');
    }
    this.socialIdentities.set(identityKey, user.id);
    this.socialProviderByUser.set(providerKey, identityKey);
    challenge.consumed = true;
    return { kind: 'authenticated', user };
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
    return [...this.adminRewards.values()].filter(reward => reward.active);
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

  async listEvents(userId: string): Promise<MemberEvent[]> {
    return this.events.filter(event => event.active).map(event => ({
      ...event,
      occurrenceStart: event.startsAt,
      attendeeCount: this.rsvps.get(`${event.id}:${event.startsAt}`)?.size ?? 0,
      reserved: this.rsvps.get(`${event.id}:${event.startsAt}`)?.has(userId) ?? false,
    }));
  }

  async rsvpToEvent(userId: string, eventId: string, occurrenceStart: string): Promise<'rsvped' | 'already_rsvped'> {
    const event = this.events.find(item => item.id === eventId && item.active);
    if (!event) throw new StoreError('event_not_found', 'Event not found.');
    const key = `${eventId}:${occurrenceStart}`;
    const attendees = this.rsvps.get(key) ?? new Set<string>();
    if (attendees.has(userId)) return 'already_rsvped';
    if (!event.rsvpOpen) throw new StoreError('rsvp_closed', 'RSVPs are closed for this event.');
    if (event.capacity !== null && attendees.size >= event.capacity) {
      throw new StoreError('event_full', 'This event has reached capacity.');
    }
    attendees.add(userId);
    this.rsvps.set(key, attendees);
    return 'rsvped';
  }

  async cancelEventRsvp(userId: string, eventId: string, occurrenceStart: string): Promise<boolean> {
    const attendees = this.rsvps.get(`${eventId}:${occurrenceStart}`);
    return attendees?.delete(userId) ?? false;
  }

  async listEventAttendees(
    eventId: string,
    occurrenceStart: string,
    limit: number,
    offset: number,
  ): Promise<{ event: EventRecord; total: number; attendees: EventAttendee[] }> {
    const event = this.events.find(item => item.id === eventId);
    if (!event) throw new StoreError('event_not_found', 'Event not found.');
    const attendees = [...(this.rsvps.get(`${eventId}:${occurrenceStart}`) ?? [])]
      .map(userId => [...this.users.values()].find(user => user.id === userId))
      .filter((user): user is UserRecord => Boolean(user))
      .map(user => ({ userId: user.id, name: user.name, rsvpAt: new Date().toISOString() }));
    return { event, total: attendees.length, attendees: attendees.slice(offset, offset + limit) };
  }

  async searchUsers(query: string, limit: number, offset: number): Promise<{ users: AdminUser[]; total: number }> {
    const matches = [...this.users.values()]
      .filter(user => user.name.toLowerCase().includes(query.toLowerCase()) ||
        user.email.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => left.email.localeCompare(right.email));
    return {
      users: matches.slice(offset, offset + limit).map(user => ({
        ...this.account(user.id),
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      })),
      total: matches.length,
    };
  }

  async getPointsSummary(): Promise<PointsSummary> {
    const values = [...this.users.values()].map(user => this.balances.get(user.id) ?? 0);
    return {
      totalUsers: values.length,
      usersWithPoints: values.filter(value => value > 0).length,
      totalPoints: values.reduce((sum, value) => sum + value, 0),
    };
  }

  async getUserPoints(
    userId: string,
    _limit: number,
    _offset: number,
  ): Promise<{ balance: number; entries: PointsLedgerEntry[]; total: number }> {
    return { balance: this.account(userId).rewardPoints, entries: [], total: 0 };
  }

  async listAdminEvents(): Promise<EventRecord[]> {
    return this.events;
  }

  async listAdminRewards(): Promise<AdminReward[]> {
    return [...this.adminRewards.values()];
  }

  async createEvent(actorId: string, input: EventInput): Promise<EventRecord> {
    if (this.events.some(event => event.id === input.id)) {
      throw new StoreError('event_conflict', 'An event with this ID already exists.');
    }
    const event = { ...input, active: true };
    this.events.push(event);
    this.audit.push({ actorId, action: 'event.create', targetId: event.id });
    return event;
  }

  async updateEvent(actorId: string, eventId: string, input: EventInput): Promise<EventRecord> {
    const index = this.events.findIndex(event => event.id === eventId);
    if (index < 0) throw new StoreError('event_not_found', 'Event not found.');
    const event = { ...input, active: this.events[index].active };
    this.events[index] = event;
    this.audit.push({ actorId, action: 'event.update', targetId: eventId });
    return event;
  }

  async archiveEvent(actorId: string, eventId: string): Promise<void> {
    const event = this.events.find(item => item.id === eventId && item.active);
    if (!event) throw new StoreError('event_not_found', 'Event not found or already archived.');
    event.active = false;
    event.rsvpOpen = false;
    this.audit.push({ actorId, action: 'event.archive', targetId: eventId });
  }

  async createReward(actorId: string, reward: Reward): Promise<AdminReward> {
    if (this.adminRewards.has(reward.id)) {
      throw new StoreError('reward_conflict', 'A reward with this ID already exists.');
    }
    const created = { ...reward, active: true };
    this.adminRewards.set(created.id, created);
    this.audit.push({ actorId, action: 'reward.create', targetId: created.id });
    return created;
  }

  async updateReward(actorId: string, rewardId: string, reward: Omit<Reward, 'id'>): Promise<AdminReward> {
    const current = this.adminRewards.get(rewardId);
    if (!current) throw new StoreError('reward_not_found', 'Reward not found.');
    const updated = { id: rewardId, ...reward, active: current.active };
    this.adminRewards.set(rewardId, updated);
    this.audit.push({ actorId, action: 'reward.update', targetId: rewardId });
    return updated;
  }

  async archiveReward(actorId: string, rewardId: string): Promise<void> {
    const reward = this.adminRewards.get(rewardId);
    if (!reward || !reward.active) throw new StoreError('reward_not_found', 'Reward not found or already archived.');
    reward.active = false;
    this.audit.push({ actorId, action: 'reward.archive', targetId: rewardId });
  }

  async assignUserRole(actorId: string, userId: string, role: UserRole): Promise<void> {
    if (actorId === userId) throw new StoreError('self_role_change', 'Admins cannot change their own role.');
    const user = [...this.users.values()].find(item => item.id === userId);
    if (!user) throw new StoreError('user_not_found', 'User not found.');
    if (user.role === 'admin' && role !== 'admin' &&
      [...this.users.values()].filter(item => item.role === 'admin').length <= 1) {
      throw new StoreError('last_admin', 'The last admin cannot be demoted.');
    }
    const previousRole = user.role;
    user.role = role;
    if (previousRole !== role) this.audit.push({ actorId, action: 'user.role_change', targetId: userId });
  }

  private account(userId: string): Account {
    const user = [...this.users.values()].find(item => item.id === userId);
    if (!user) throw new Error('Memory store user not found.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      rewardPoints: this.balances.get(userId) ?? 0,
      role: user.role,
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
  googleClientIds: ['green-fork-google-client-id'],
  appleBundleId: 'com.greenfork.rewards',
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
const socialProfiles = new Map<string, VerifiedSocialIdentity>();
const socialTokenVerifier: SocialTokenVerifier = {
  async verify(provider, token) {
    if (token === 'invalid-token') throw new InvalidSocialTokenError();
    const profile = socialProfiles.get(`${provider}:${token}`);
    if (!profile) throw new InvalidSocialTokenError();
    return profile;
  },
};
const app = createApp({ config, store, emailSender, socialTokenVerifier });

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
  const memberPasswordHash = [...store.users.values()][0].passwordHash;
  assert.ok(memberPasswordHash);
  assert.equal(memberPasswordHash.includes('StrongPass!123'), false);

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

test('social sign-in creates accounts, links verified emails, and consumes nonces once', async () => {
  const googleToken = 'google-new-member-token';
  socialProfiles.set('google:google-new-member-token', {
    subject: 'google-subject-new-member',
    email: 'social-member@example.com',
    emailVerified: true,
    name: null,
  });
  const nonceResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/social/nonce',
    payload: { provider: 'google' },
  });
  assert.equal(nonceResponse.statusCode, 200);
  const nonce = nonceResponse.json<{ nonce: string }>().nonce;

  const needsName = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    headers: { 'x-session-transport': 'native' },
    payload: { provider: 'google', idToken: googleToken, nonce },
  });
  assert.equal(needsName.statusCode, 428);
  assert.equal(needsName.json<{ error: { code: string } }>().error.code, 'display_name_required');

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    headers: { 'x-session-transport': 'native' },
    payload: { provider: 'google', idToken: googleToken, nonce, name: 'Social Member' },
  });
  assert.equal(login.statusCode, 200);
  const firstSession = login.json<{ account: Account; refreshToken: string }>();
  assert.equal(firstSession.account.email, 'social-member@example.com');
  assert.equal(firstSession.account.role, 'member');
  assert.ok(firstSession.refreshToken);
  assert.equal(store.users.get('social-member@example.com')?.passwordHash, null);
  const passwordLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'social-member@example.com', password: 'StrongPass!123' },
  });
  assert.equal(passwordLogin.statusCode, 401);

  const replay = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    headers: { 'x-session-transport': 'native' },
    payload: { provider: 'google', idToken: googleToken, nonce, name: 'Social Member' },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json<{ error: { code: string } }>().error.code, 'social_nonce_invalid');

  const repeatNonce = await app.inject({
    method: 'POST',
    url: '/api/auth/social/nonce',
    payload: { provider: 'google' },
  });
  const repeatLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    headers: { 'x-session-transport': 'native' },
    payload: {
      provider: 'google',
      idToken: googleToken,
      nonce: repeatNonce.json<{ nonce: string }>().nonce,
    },
  });
  assert.equal(repeatLogin.statusCode, 200);
  assert.equal(repeatLogin.json<{ account: Account }>().account.id, firstSession.account.id);

  const existing = await store.createUser(
    randomUUID(),
    'Existing Member',
    'existing-social@example.com',
    'existing-password-hash',
  );
  assert.ok(existing);
  existing.emailVerifiedAt = new Date();
  socialProfiles.set('apple:apple-existing-member-token', {
    subject: 'apple-subject-existing-member',
    email: 'EXISTING-SOCIAL@EXAMPLE.COM',
    emailVerified: true,
    name: null,
  });
  const appleNonce = await app.inject({
    method: 'POST',
    url: '/api/auth/social/nonce',
    payload: { provider: 'apple' },
  });
  const appleLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    headers: { 'x-session-transport': 'native' },
    payload: {
      provider: 'apple',
      idToken: 'apple-existing-member-token',
      nonce: appleNonce.json<{ nonce: string }>().nonce,
    },
  });
  assert.equal(appleLogin.statusCode, 200);
  assert.equal(appleLogin.json<{ account: Account }>().account.id, existing.id);
  assert.equal(existing.passwordHash, 'existing-password-hash');

  socialProfiles.set('google:google-unverified-token', {
    subject: 'google-subject-unverified',
    email: 'unverified-social@example.com',
    emailVerified: false,
    name: 'Unverified',
  });
  const unverifiedNonce = await app.inject({
    method: 'POST',
    url: '/api/auth/social/nonce',
    payload: { provider: 'google' },
  });
  const unverified = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    payload: {
      provider: 'google',
      idToken: 'google-unverified-token',
      nonce: unverifiedNonce.json<{ nonce: string }>().nonce,
    },
  });
  assert.equal(unverified.statusCode, 400);
  assert.equal(store.users.has('unverified-social@example.com'), false);

  const invalidNonce = await app.inject({
    method: 'POST',
    url: '/api/auth/social/nonce',
    payload: { provider: 'google' },
  });
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/auth/social/login',
    payload: {
      provider: 'google',
      idToken: 'invalid-token',
      nonce: invalidNonce.json<{ nonce: string }>().nonce,
    },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json<{ error: { code: string } }>().error.code, 'invalid_social_credential');
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

test('staff and admin routes enforce roles, return limited data, and audit admin writes', async () => {
  const member = await store.createUser(randomUUID(), 'RBAC Member', 'rbac-member@example.com', 'hash');
  const staff = await store.createUser(randomUUID(), 'RBAC Staff', 'rbac-staff@example.com', 'hash');
  const admin = await store.createUser(randomUUID(), 'RBAC Admin', 'rbac-admin@example.com', 'hash');
  assert.ok(member && staff && admin);
  staff.role = 'staff';
  admin.role = 'admin';
  const credentials = [
    { userId: member.id, access: 'rbac-member-access' },
    { userId: staff.id, access: 'rbac-staff-access' },
    { userId: admin.id, access: 'rbac-admin-access' },
  ];
  for (const credential of credentials) {
    await store.createSession(
      randomUUID(),
      credential.userId,
      hashOpaqueToken(credential.access),
      hashOpaqueToken(`${credential.access}-refresh`),
      new Date(Date.now() + 60_000),
      new Date(Date.now() + 60_000),
    );
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const memberAuth = auth('rbac-member-access');
  const staffAuth = auth('rbac-staff-access');
  const adminAuth = auth('rbac-admin-access');

  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/users?q=rbac' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/points', headers: memberAuth })).statusCode, 403);

  const search = await app.inject({
    method: 'GET',
    url: '/api/admin/users?q=rbac',
    headers: staffAuth,
  });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json<{ users: unknown[]; total: number }>().total, 3);
  assert.equal(JSON.stringify(search.json()).includes('passwordHash'), false);

  const rsvp = await app.inject({
    method: 'POST',
    url: '/api/events/tasting/rsvp',
    headers: memberAuth,
    payload: { occurrenceStart: '2026-11-14T16:00:00.000Z' },
  });
  assert.equal(rsvp.statusCode, 201);
  const attendees = await app.inject({
    method: 'GET',
    url: '/api/admin/events/tasting/attendees?occurrenceStart=2026-11-14T16%3A00%3A00.000Z',
    headers: staffAuth,
  });
  assert.equal(attendees.statusCode, 200);
  const attendeeData = attendees.json<{ attendees: Array<Record<string, unknown>>; total: number }>();
  assert.equal(attendeeData.total, 1);
  assert.equal(attendeeData.attendees[0].name, 'RBAC Member');
  assert.equal('email' in attendeeData.attendees[0], false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/events', headers: staffAuth })).statusCode, 403);

  const eventInput = {
    title: 'RBAC test event',
    startsAt: '2027-01-01T10:00:00Z',
    description: 'Test event',
    tag: 'TEST',
    capacity: 2,
    rsvpOpen: true,
    recurrence: 'weekly',
    recurrenceUntil: null,
  };
  const createdEvent = await app.inject({
    method: 'POST',
    url: '/api/admin/events',
    headers: adminAuth,
    payload: { ...eventInput, id: 'client-controlled-id' },
  });
  assert.equal(createdEvent.statusCode, 201);
  const eventId = createdEvent.json<{ event: EventRecord }>().event.id;
  assert.notEqual(eventId, 'client-controlled-id');
  const eventOccurrence = '2027-01-01T10:00:00.000Z';
  const rsvpCreated = await app.inject({
    method: 'POST',
    url: `/api/events/${eventId}/rsvp`,
    headers: memberAuth,
    payload: { occurrenceStart: eventOccurrence },
  });
  assert.equal(rsvpCreated.statusCode, 201);
  const separateOccurrence = await app.inject({
    method: 'POST',
    url: `/api/events/${eventId}/rsvp`,
    headers: memberAuth,
    payload: { occurrenceStart: '2027-01-08T10:00:00.000Z' },
  });
  assert.equal(separateOccurrence.statusCode, 201);
  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/admin/events/${eventId}/update`,
    headers: adminAuth,
    payload: { ...eventInput, capacity: 1 },
  })).statusCode, 200);
  const full = await app.inject({
    method: 'POST',
    url: `/api/events/${eventId}/rsvp`,
    headers: staffAuth,
    payload: { occurrenceStart: eventOccurrence },
  });
  assert.equal(full.statusCode, 409);
  assert.equal(full.json<{ error: { code: string } }>().error.code, 'event_full');

  const rewardInput = { name: 'RBAC reward', pointsCost: 75, icon: '🎁' };
  const createdReward = await app.inject({
    method: 'POST',
    url: '/api/admin/rewards',
    headers: adminAuth,
    payload: { ...rewardInput, id: 'client-controlled-reward' },
  });
  assert.equal(createdReward.statusCode, 201);
  const rewardId = createdReward.json<{ reward: { id: string } }>().reward.id;
  assert.notEqual(rewardId, 'client-controlled-reward');
  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/admin/rewards/${rewardId}/update`,
    headers: adminAuth,
    payload: { ...rewardInput, pointsCost: 90 },
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/admin/rewards/${rewardId}/archive`,
    headers: adminAuth,
    payload: {},
  })).statusCode, 200);

  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/admin/users/${staff.id}/role`,
    headers: adminAuth,
    payload: { role: 'admin' },
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST',
    url: `/api/admin/users/${admin.id}/role`,
    headers: adminAuth,
    payload: { role: 'staff' },
  })).statusCode, 409);
  assert.ok(store.audit.some(entry => entry.action === 'user.role_change'));
  assert.ok(store.audit.some(entry => entry.action === 'event.create'));
  assert.ok(store.audit.some(entry => entry.action === 'reward.archive'));
});

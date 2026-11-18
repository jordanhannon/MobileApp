import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type {
  Account, AnnouncementAudience, EventInput, NotificationPreferences, PushPlatform,
  Reward, SocialIdentityProvider, UserRole,
} from './domain.js';
import { StoreError } from './domain.js';
import {
  createEmailCode, createId, createOpaqueToken, hashEmailCode, hashOpaqueToken, hashPassword, normalizeEmail, verifyPassword,
} from './crypto.js';
import type { AppConfig } from './config.js';
import type { EmailSender } from './email.js';
import type { Store } from './store.js';
import { InvalidSocialTokenError, OidcSocialTokenVerifier } from './socialAuth.js';
import type { SocialTokenVerifier } from './socialAuth.js';

type AppDependencies = {
  config: AppConfig;
  store: Store;
  emailSender: EmailSender;
  socialTokenVerifier?: SocialTokenVerifier;
};

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let missingAccountHash: Promise<string> | null = null;

function missingAccountPasswordHash(): Promise<string> {
  missingAccountHash ??= hashPassword('nonexistent-account-password-check');
  return missingAccountHash;
}

declare module 'fastify' {
  interface FastifyRequest {
    account: Account | null;
  }
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ApiError(400, 'invalid_request', `Invalid ${key}.`);
  }
  return value;
}

function emailField(body: Record<string, unknown>): string {
  const email = normalizeEmail(stringField(body, 'email', 3, 320));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'invalid_request', 'Enter a valid email address.');
  }
  return email;
}

function socialProviderField(body: Record<string, unknown>): SocialIdentityProvider {
  const provider = body.provider;
  if (provider !== 'google' && provider !== 'apple') {
    throw new ApiError(400, 'invalid_request', 'Choose Google or Apple sign-in.');
  }
  return provider;
}

function optionalNameField(body: Record<string, unknown>): string | null {
  const name = body.name;
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string' || name.trim().length > 100) {
    throw new ApiError(400, 'invalid_request', 'Invalid display name.');
  }
  return name.trim() || null;
}

function passwordField(body: Record<string, unknown>, key = 'password'): string {
  const password = stringField(body, key, 8, 128);
  return password;
}

function roleField(body: Record<string, unknown>): UserRole {
  const role = body.role;
  if (role !== 'member' && role !== 'staff' && role !== 'admin') {
    throw new ApiError(400, 'invalid_request', 'Invalid role.');
  }
  return role;
}

function routeParameter(request: FastifyRequest, key: string, maxLength = 100): string {
  const params = bodyRecord(request.params);
  return stringField(params, key, 1, maxLength);
}

function slugParameter(value: string): string {
  const slug = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) {
    throw new ApiError(400, 'invalid_request', 'Invalid identifier.');
  }
  return slug;
}

function uuidParameter(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'invalid_request', 'Invalid user ID.');
  }
  return value;
}

function pagination(request: FastifyRequest): { page: number; limit: number; offset: number } {
  const query = bodyRecord(request.query);
  const parse = (key: string, fallback: number, max: number): number => {
    const raw = query[key];
    if (raw === undefined) return fallback;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new ApiError(400, 'invalid_request', `Invalid ${key}.`);
    }
    return value;
  };
  const page = parse('page', 1, 100000);
  const limit = parse('pageSize', 25, 100);
  return { page, limit, offset: (page - 1) * limit };
}

function dateInEasternTime(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function eventInput(body: Record<string, unknown>, id: string): EventInput {
  const startsAtInput = stringField(body, 'startsAt', 1, 40);
  const startsAt = new Date(startsAtInput);
  const capacity = body.capacity;
  const recurrence = body.recurrence;
  const recurrenceUntil = body.recurrenceUntil;
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(startsAtInput) || !Number.isFinite(startsAt.getTime())) {
    throw new ApiError(400, 'invalid_request', 'Event start time must include a valid time zone.');
  }
  if (
    capacity !== null &&
    (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 100000)
  ) {
    throw new ApiError(400, 'invalid_request', 'Invalid capacity.');
  }
  if (typeof body.rsvpOpen !== 'boolean') {
    throw new ApiError(400, 'invalid_request', 'Invalid RSVP status.');
  }
  if (body.bracketEnabled !== undefined && typeof body.bracketEnabled !== 'boolean') {
    throw new ApiError(400, 'invalid_request', 'Invalid bracket setting.');
  }
  if (recurrence !== 'none' && recurrence !== 'weekly' && recurrence !== 'monthly') {
    throw new ApiError(400, 'invalid_request', 'Invalid event recurrence.');
  }
  if (
    recurrenceUntil !== null &&
    (typeof recurrenceUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recurrenceUntil) ||
      !Number.isFinite(Date.parse(`${recurrenceUntil}T00:00:00Z`)) ||
      new Date(`${recurrenceUntil}T00:00:00Z`).toISOString().slice(0, 10) !== recurrenceUntil)
  ) {
    throw new ApiError(400, 'invalid_request', 'Invalid recurrence end date.');
  }
  if (recurrence === 'none' && recurrenceUntil !== null) {
    throw new ApiError(400, 'invalid_request', 'A one-time event cannot have a recurrence end date.');
  }
  if (recurrence !== 'none' && typeof recurrenceUntil === 'string' &&
    recurrenceUntil < dateInEasternTime(startsAt)) {
    throw new ApiError(400, 'invalid_request', 'The recurrence end date must be on or after the event date.');
  }
  return {
    id,
    title: stringField(body, 'title', 1, 120).trim(),
    startsAt: startsAt.toISOString(),
    description: stringField(body, 'description', 1, 2000).trim(),
    tag: stringField(body, 'tag', 1, 60).trim(),
    capacity,
    rsvpOpen: body.rsvpOpen,
    bracketEnabled: body.bracketEnabled === true,
    recurrence,
    recurrenceUntil,
  };
}

function rewardInput(body: Record<string, unknown>, id?: string): Reward {
  const pointsCost = body.pointsCost;
  if (typeof pointsCost !== 'number' || !Number.isInteger(pointsCost) || pointsCost < 1 || pointsCost > 1000000) {
    throw new ApiError(400, 'invalid_request', 'Invalid reward point cost.');
  }
  const rewardId = slugParameter(id ?? createId());
  return {
    id: rewardId,
    name: stringField(body, 'name', 1, 120).trim(),
    pointsCost,
    icon: stringField(body, 'icon', 1, 16),
  };
}

function notificationPreferencesInput(body: Record<string, unknown>): NotificationPreferences {
  const booleanFields = [
    'rsvpUpdatesEnabled', 'eventChangesEnabled', 'rewardsEnabled',
    'announcementsEnabled', 'pushEnabled',
  ] as const;
  for (const field of booleanFields) {
    if (typeof body[field] !== 'boolean') {
      throw new ApiError(400, 'invalid_request', `Invalid ${field}.`);
    }
  }
  const reminderSchedule = body.reminderSchedule;
  if (reminderSchedule !== 'off' && reminderSchedule !== '24h' &&
    reminderSchedule !== '1h' && reminderSchedule !== '24h_1h') {
    throw new ApiError(400, 'invalid_request', 'Invalid reminder schedule.');
  }
  return {
    rsvpUpdatesEnabled: body.rsvpUpdatesEnabled as boolean,
    eventChangesEnabled: body.eventChangesEnabled as boolean,
    rewardsEnabled: body.rewardsEnabled as boolean,
    announcementsEnabled: body.announcementsEnabled as boolean,
    pushEnabled: body.pushEnabled as boolean,
    reminderSchedule,
  };
}

function announcementAudienceInput(body: Record<string, unknown>): AnnouncementAudience {
  if (body.type === 'all') return { type: 'all' };
  if (body.type !== 'event') throw new ApiError(400, 'invalid_request', 'Choose a supported announcement audience.');
  const eventId = slugParameter(stringField(body, 'eventId', 2, 80));
  const occurrenceInput = stringField(body, 'occurrenceStart', 1, 40);
  const occurrenceStart = new Date(occurrenceInput);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(occurrenceInput) || !Number.isFinite(occurrenceStart.getTime())) {
    throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
  }
  return { type: 'event', eventId, occurrenceStart: occurrenceStart.toISOString() };
}

function nativeTransport(request: FastifyRequest): boolean {
  return request.headers['x-session-transport'] === 'native';
}

function refreshTokenFromRequest(request: FastifyRequest): string | null {
  if (nativeTransport(request)) {
    const body = request.body;
    if (typeof body === 'object' && body !== null && 'refreshToken' in body) {
      const token = body.refreshToken;
      return typeof token === 'string' ? token : null;
    }
    return null;
  }
  return request.cookies.gf_refresh ?? null;
}

function setRefreshCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(config.sessionCookieName, token, {
    path: '/api/auth',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    maxAge: config.refreshTokenDays * 24 * 60 * 60,
  });
}

function clearRefreshCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.sessionCookieName, {
    path: '/api/auth',
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
  });
}

function expiresAfterSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function accountResponse(account: Account): Account {
  return account;
}

export function createApp({ config, store, emailSender, socialTokenVerifier = new OidcSocialTokenVerifier() }: AppDependencies) {
  const app = Fastify({ logger: config.nodeEnv !== 'test' });

  app.decorateRequest('account', null);
  app.register(cookie);
  app.register(cors, {
    origin: config.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-session-transport', 'idempotency-key'],
  });
  app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  app.addHook('onRequest', async (request, reply) => {
    if (
      request.headers['x-session-transport'] === 'cookie' &&
      (!request.headers.origin || !config.allowedOrigins.includes(request.headers.origin))
    ) {
      return reply.code(403).send({ error: { code: 'origin_not_allowed', message: 'Request origin is not allowed.' } });
    }
  });

  const requireAccount = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = request.headers.authorization;
    const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!accessToken) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
      return;
    }
    request.account = await store.findAccountByAccessTokenHash(hashOpaqueToken(accessToken));
    if (!request.account) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
    }
  };

  const requireRole = (...roles: UserRole[]) => async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAccount(request, reply);
    if (reply.sent || !request.account) return;
    if (!roles.includes(request.account.role)) {
      reply.code(403).send({ error: { code: 'forbidden', message: 'You do not have permission to do that.' } });
    }
  };

  async function sendEmailCode(userId: string, email: string, purpose: 'verify_email' | 'reset_password') {
    const code = createEmailCode();
    await store.issueEmailToken(
      userId,
      purpose,
      hashEmailCode(code, config.tokenHashSecret),
      expiresAfterSeconds(15 * 60),
    );
    if (purpose === 'verify_email') {
      await emailSender.sendVerificationCode(email, code);
    } else {
      await emailSender.sendPasswordResetCode(email, code);
    }
  }

  async function issueSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
    const accessToken = createOpaqueToken();
    const refreshToken = createOpaqueToken();
    const account = await store.createSession(
      createId(),
      userId,
      hashOpaqueToken(accessToken),
      hashOpaqueToken(refreshToken),
      expiresAfterSeconds(config.accessTokenMinutes * 60),
      expiresAfterSeconds(config.refreshTokenDays * 24 * 60 * 60),
    );
    setRefreshCookie(reply, config, refreshToken);
    return {
      accessToken,
      ...(nativeTransport(request) ? { refreshToken } : {}),
      account: accountResponse(account),
    };
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof StoreError) {
      const status = error.code.endsWith('_not_found') ? 404
        : error.code === 'rsvp_closed' || error.code === 'event_full' ||
          error.code === 'capacity_below_attendance' || error.code === 'last_admin' ||
          error.code === 'self_role_change' || error.code.endsWith('_conflict') ? 409
          : 400;
      reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      Boolean(error.validation)
    ) {
      reply.code(400).send({ error: { code: 'invalid_request', message: 'Request validation failed.' } });
      return;
    }
    request.log.error({ err: error }, 'Unhandled API error');
    reply.code(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    const name = stringField(body, 'name', 1, 100).trim();
    const email = emailField(body);
    const password = passwordField(body);
    if (!name) throw new ApiError(400, 'invalid_request', 'Enter your name.');

    const existing = await store.findUserByEmail(email);
    if (!existing) {
      const user = await store.createUser(createId(), name, email, await hashPassword(password));
      if (user) await sendEmailCode(user.id, user.email, 'verify_email');
    }
    return reply.code(202).send({ message: 'If this address can be registered, a verification code has been sent.' });
  });

  app.post('/api/auth/verification/request', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const email = emailField(bodyRecord(request.body));
    const user = await store.findUserByEmail(email);
    if (user && !user.emailVerifiedAt) await sendEmailCode(user.id, user.email, 'verify_email');
    return { message: 'If this account needs verification, a code has been sent.' };
  });

  app.post('/api/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = bodyRecord(request.body);
    const email = emailField(body);
    const code = stringField(body, 'code', 8, 8);
    const verified = await store.verifyEmail(email, hashEmailCode(code, config.tokenHashSecret));
    if (!verified) throw new ApiError(400, 'invalid_or_expired_code', 'The verification code is invalid or expired.');
    return { verified: true };
  });

  app.post('/api/auth/social/nonce', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const provider = socialProviderField(bodyRecord(request.body));
    const audiences = provider === 'google' ? config.googleClientIds : [config.appleBundleId];
    if (audiences.length === 0 || audiences.every(audience => audience === '')) {
      throw new ApiError(503, 'social_provider_not_configured', `${provider} sign-in is not configured.`);
    }
    const nonce = createOpaqueToken();
    await store.issueSocialNonce(provider, hashOpaqueToken(nonce), expiresAfterSeconds(5 * 60));
    return { nonce };
  });

  app.post(
    '/api/auth/social/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = bodyRecord(request.body);
      const provider = socialProviderField(body);
      const idToken = stringField(body, 'idToken', 1, 8192);
      const nonce = stringField(body, 'nonce', 32, 128);
      const audiences = provider === 'google' ? config.googleClientIds : [config.appleBundleId].filter(Boolean);
      if (audiences.length === 0) {
        throw new ApiError(503, 'social_provider_not_configured', `${provider} sign-in is not configured.`);
      }

      let profile;
      try {
        profile = await socialTokenVerifier.verify(provider, idToken, nonce, audiences);
      } catch (error) {
        if (error instanceof InvalidSocialTokenError) {
          throw new ApiError(401, 'invalid_social_credential', 'The identity provider could not verify this sign-in.');
        }
        throw error;
      }

      const email = profile.email ? normalizeEmail(profile.email) : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError(401, 'invalid_social_credential', 'The identity provider returned an invalid email.');
      }
      const result = await store.resolveSocialIdentity({
        id: createId(),
        provider,
        subject: profile.subject,
        email,
        emailVerified: profile.emailVerified,
        name: optionalNameField(body) ?? profile.name,
        nonceHash: hashOpaqueToken(nonce),
      });
      if (result.kind === 'profile_required') {
        throw new ApiError(428, 'display_name_required', 'Enter your name to finish creating your account.');
      }
      return issueSession(request, reply, result.user.id);
    },
  );

  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    const email = emailField(body);
    const password = passwordField(body);
    const user = await store.findUserByEmail(email);
    const passwordMatches = user?.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : await verifyPassword(await missingAccountPasswordHash(), password);
    if (!user || !passwordMatches || !user.emailVerifiedAt) {
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    return issueSession(request, reply, user.id);
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const refreshToken = refreshTokenFromRequest(request);
    if (!refreshToken) throw new ApiError(401, 'invalid_session', 'Sign in to continue.');
    const accessToken = createOpaqueToken();
    const nextRefreshToken = createOpaqueToken();
    const account = await store.rotateSession(
      hashOpaqueToken(refreshToken),
      hashOpaqueToken(accessToken),
      hashOpaqueToken(nextRefreshToken),
      expiresAfterSeconds(config.accessTokenMinutes * 60),
      expiresAfterSeconds(config.refreshTokenDays * 24 * 60 * 60),
    );
    if (!account) throw new ApiError(401, 'invalid_session', 'Sign in to continue.');
    setRefreshCookie(reply, config, nextRefreshToken);
    return {
      accessToken,
      ...(nativeTransport(request) ? { refreshToken: nextRefreshToken } : {}),
      account: accountResponse(account),
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const refreshToken = refreshTokenFromRequest(request);
    if (refreshToken) await store.revokeSession(hashOpaqueToken(refreshToken));
    clearRefreshCookie(reply, config);
    return reply.code(204).send();
  });

  app.post('/api/auth/password-reset/request', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const email = emailField(bodyRecord(request.body));
    const user = await store.findUserByEmail(email);
    if (user?.emailVerifiedAt) await sendEmailCode(user.id, user.email, 'reset_password');
    return { message: 'If an eligible account exists, a reset code has been sent.' };
  });

  app.post('/api/auth/password-reset/confirm', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async request => {
    const body = bodyRecord(request.body);
    const email = emailField(body);
    const code = stringField(body, 'code', 8, 8);
    const passwordHash = await hashPassword(passwordField(body, 'newPassword'));
    const reset = await store.resetPassword(email, hashEmailCode(code, config.tokenHashSecret), passwordHash);
    if (!reset) throw new ApiError(400, 'invalid_or_expired_code', 'The reset code is invalid or expired.');
    return { reset: true };
  });

  app.get('/api/me', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    return { account: request.account };
  });

  app.get('/api/notifications', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const page = pagination(request);
    return {
      ...await store.listNotifications(request.account.id, page.limit, page.offset),
      page: page.page,
      pageSize: page.limit,
    };
  });

  app.post('/api/notifications/read-all', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    return { updated: await store.markAllNotificationsRead(request.account.id) };
  });

  app.post('/api/notifications/:notificationId/read', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const notificationId = uuidParameter(routeParameter(request, 'notificationId', 36));
    if (!await store.markNotificationRead(request.account.id, notificationId)) {
      throw new ApiError(404, 'notification_not_found', 'Notification not found.');
    }
    return { read: true };
  });

  app.get('/api/notifications/preferences', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    return { preferences: await store.getNotificationPreferences(request.account.id) };
  });

  app.post('/api/notifications/preferences', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    return {
      preferences: await store.updateNotificationPreferences(
        request.account.id,
        notificationPreferencesInput(bodyRecord(request.body)),
      ),
    };
  });

  app.post('/api/notifications/push-token', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const body = bodyRecord(request.body);
    const token = stringField(body, 'token', 20, 500);
    if (!/^(Exponent|Expo)PushToken\[[A-Za-z0-9._-]{1,250}\]$/.test(token)) {
      throw new ApiError(400, 'invalid_request', 'Invalid Expo push token.');
    }
    const platform = body.platform;
    if (platform !== 'ios' && platform !== 'android') {
      throw new ApiError(400, 'invalid_request', 'Invalid push token platform.');
    }
    await store.registerPushToken(request.account.id, token, platform as PushPlatform);
    return { registered: true };
  });

  app.delete('/api/notifications/push-token', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const token = stringField(bodyRecord(request.body), 'token', 20, 500);
    if (!/^(Exponent|Expo)PushToken\[[A-Za-z0-9._-]{1,250}\]$/.test(token)) {
      throw new ApiError(400, 'invalid_request', 'Invalid Expo push token.');
    }
    await store.revokePushToken(request.account.id, token);
    return { revoked: true };
  });

  app.get('/api/rewards', { preHandler: requireAccount }, async () => ({ rewards: await store.listRewards() }));

  app.get('/api/events', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    await store.finalizeDueBrackets();
    const query = bodyRecord(request.query);
    if (query.month !== undefined) {
      if (typeof query.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) || Number(query.month.slice(0, 4)) < 1) {
        throw new ApiError(400, 'invalid_request', 'Invalid month.');
      }
      return { events: await store.listEventsForMonth(request.account.id, `${query.month}-01`) };
    }
    return { events: await store.listEvents(request.account.id) };
  });

  app.get('/api/events/:eventId/bracket', { preHandler: requireAccount }, async request => {
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const query = bodyRecord(request.query);
    const occurrenceStart = new Date(stringField(query, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    await store.finalizeDueBrackets();
    return {
      bracket: await store.getEventBracket(eventId, occurrenceStart.toISOString()),
    };
  });

  app.get('/api/admin/events/:eventId/bracket/guests', {
    preHandler: requireRole('staff', 'admin'),
  }, async request => {
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const query = bodyRecord(request.query);
    const occurrenceStart = new Date(stringField(query, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    return {
      guests: await store.listBracketGuests(eventId, occurrenceStart.toISOString()),
    };
  });

  app.post('/api/admin/events/:eventId/bracket/guests', {
    preHandler: requireRole('staff', 'admin'),
  }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    const name = stringField(body, 'name', 1, 120).trim();
    if (!name) throw new ApiError(400, 'invalid_request', 'Guest name is required.');
    return {
      guest: await store.addBracketGuest(
        request.account.id,
        eventId,
        occurrenceStart.toISOString(),
        name,
      ),
    };
  });

  app.post('/api/admin/events/:eventId/bracket/guests/:guestId/remove', {
    preHandler: requireRole('staff', 'admin'),
  }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const guestId = uuidParameter(routeParameter(request, 'guestId', 36));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    await store.removeBracketGuest(request.account.id, eventId, occurrenceStart.toISOString(), guestId);
    return { removed: true };
  });

  app.post('/api/admin/events/:eventId/bracket/draw', {
    preHandler: requireRole('staff', 'admin'),
  }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    return {
      bracket: await store.drawEventBracket(request.account.id, eventId, occurrenceStart.toISOString()),
    };
  });

  app.post('/api/admin/events/:eventId/bracket/matches/:matchId/winner', {
    preHandler: requireRole('staff', 'admin'),
  }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const matchId = uuidParameter(routeParameter(request, 'matchId', 36));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    const winnerEntrantId = uuidParameter(stringField(body, 'winnerEntrantId', 1, 36));
    return {
      bracket: await store.recordBracketWinner(
        request.account.id,
        eventId,
        occurrenceStart.toISOString(),
        matchId,
        winnerEntrantId,
      ),
    };
  });

  app.post('/api/events/:eventId/rsvp', { preHandler: requireAccount }, async (request, reply) => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    const result = await store.rsvpToEvent(request.account.id, eventId, occurrenceStart.toISOString());
    return reply.code(result === 'rsvped' ? 201 : 200).send({ rsvped: true, alreadyApplied: result === 'already_rsvped' });
  });

  app.post('/api/events/:eventId/cancel', { preHandler: requireAccount }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const body = bodyRecord(request.body);
    const occurrenceStart = new Date(stringField(body, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    return {
      cancelled: await store.cancelEventRsvp(request.account.id, eventId, occurrenceStart.toISOString()),
    };
  });

  app.get('/api/admin/users', { preHandler: requireRole('staff', 'admin') }, async request => {
    const query = bodyRecord(request.query);
    const search = typeof query.q === 'string' ? query.q.trim() : '';
    if (search.length < 2 || search.length > 200) {
      throw new ApiError(400, 'invalid_request', 'Search text must be between 2 and 200 characters.');
    }
    const page = pagination(request);
    const result = await store.searchUsers(search, page.limit, page.offset);
    return { ...result, page: page.page, pageSize: page.limit };
  });

  app.get('/api/admin/points', { preHandler: requireRole('staff', 'admin') }, async () => ({
    summary: await store.getPointsSummary(),
  }));

  app.get('/api/admin/users/:userId/points', { preHandler: requireRole('staff', 'admin') }, async request => {
    const userId = uuidParameter(routeParameter(request, 'userId', 36));
    const page = pagination(request);
    return { ...(await store.getUserPoints(userId, page.limit, page.offset)), page: page.page, pageSize: page.limit };
  });

  app.get('/api/admin/events/:eventId/attendees', { preHandler: requireRole('staff', 'admin') }, async request => {
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    const query = bodyRecord(request.query);
    const occurrenceStart = new Date(stringField(query, 'occurrenceStart', 1, 40));
    if (!Number.isFinite(occurrenceStart.getTime())) {
      throw new ApiError(400, 'invalid_request', 'Invalid event occurrence.');
    }
    const page = pagination(request);
    return {
      ...(await store.listEventAttendees(eventId, occurrenceStart.toISOString(), page.limit, page.offset)),
      page: page.page,
      pageSize: page.limit,
    };
  });

  app.get('/api/admin/events', { preHandler: requireRole('staff', 'admin') }, async () => ({
    events: await store.listAdminEvents(),
  }));

  app.post('/api/admin/events', { preHandler: requireRole('staff', 'admin') }, async (request, reply) => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const body = bodyRecord(request.body);
    const id = createId();
    const event = await store.createEvent(request.account.id, eventInput(body, id));
    return reply.code(201).send({ event });
  });

  app.post('/api/admin/events/:eventId/update', { preHandler: requireRole('staff', 'admin') }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    return { event: await store.updateEvent(request.account.id, eventId, eventInput(bodyRecord(request.body), eventId)) };
  });

  app.post('/api/admin/events/:eventId/archive', { preHandler: requireRole('staff', 'admin') }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const eventId = slugParameter(routeParameter(request, 'eventId', 80));
    await store.archiveEvent(request.account.id, eventId);
    return { archived: true };
  });

  app.post('/api/admin/announcements', { preHandler: requireRole('staff', 'admin') }, async (request, reply) => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid idempotency key is required.');
    }
    const body = bodyRecord(request.body);
    const title = stringField(body, 'title', 1, 120).trim();
    const message = stringField(body, 'body', 1, 1000).trim();
    if (!title || !message) throw new ApiError(400, 'invalid_request', 'Announcement title and message are required.');
    const result = await store.createAnnouncement(
      request.account.id,
      title,
      message,
      announcementAudienceInput(bodyRecord(body.audience)),
      idempotencyKey,
    );
    return reply.code(result.alreadyApplied ? 200 : 201).send(result);
  });

  app.get('/api/admin/rewards', { preHandler: requireRole('admin') }, async () => ({
    rewards: await store.listAdminRewards(),
  }));

  app.post('/api/admin/rewards', { preHandler: requireRole('admin') }, async (request, reply) => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const reward = await store.createReward(request.account.id, rewardInput(bodyRecord(request.body)));
    return reply.code(201).send({ reward });
  });

  app.post('/api/admin/rewards/:rewardId/update', { preHandler: requireRole('admin') }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const rewardId = slugParameter(routeParameter(request, 'rewardId', 80));
    const reward = rewardInput(bodyRecord(request.body), rewardId);
    return { reward: await store.updateReward(request.account.id, rewardId, reward) };
  });

  app.post('/api/admin/rewards/:rewardId/archive', { preHandler: requireRole('admin') }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const rewardId = slugParameter(routeParameter(request, 'rewardId', 80));
    await store.archiveReward(request.account.id, rewardId);
    return { archived: true };
  });

  app.post('/api/admin/users/:userId/role', { preHandler: requireRole('admin') }, async request => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const userId = uuidParameter(routeParameter(request, 'userId', 36));
    await store.assignUserRole(request.account.id, userId, roleField(bodyRecord(request.body)));
    return { updated: true };
  });

  app.post('/api/redemptions', { preHandler: requireAccount }, async (request, reply) => {
    if (!request.account) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    const body = bodyRecord(request.body);
    const rewardId = stringField(body, 'rewardId', 1, 80);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new ApiError(400, 'invalid_request', 'A valid idempotency key is required.');
    }
    const result = await store.redeem(request.account.id, rewardId, idempotencyKey);
    if (result.kind === 'reward_unavailable') {
      throw new ApiError(404, 'reward_unavailable', 'This reward is not available.');
    }
    if (result.kind === 'insufficient_points') {
      throw new ApiError(409, 'insufficient_points', 'There are not enough points for this reward.');
    }
    return reply.code(result.alreadyApplied ? 200 : 201).send({
      redemptionId: result.redemptionId,
      reward: result.reward,
      rewardPoints: result.balance,
      alreadyApplied: result.alreadyApplied,
    });
  });

  return app;
}

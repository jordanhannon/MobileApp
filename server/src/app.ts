import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Account } from './domain.js';
import {
  createEmailCode, createId, createOpaqueToken, hashEmailCode, hashOpaqueToken, hashPassword, normalizeEmail, verifyPassword,
} from './crypto.js';
import type { AppConfig } from './config.js';
import type { EmailSender } from './email.js';
import type { Store } from './store.js';

type AppDependencies = {
  config: AppConfig;
  store: Store;
  emailSender: EmailSender;
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

function passwordField(body: Record<string, unknown>, key = 'password'): string {
  const password = stringField(body, key, 8, 128);
  return password;
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

export function createApp({ config, store, emailSender }: AppDependencies) {
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

  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyRecord(request.body);
    const email = emailField(body);
    const password = passwordField(body);
    const user = await store.findUserByEmail(email);
    const passwordMatches = user
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

  app.get('/api/rewards', { preHandler: requireAccount }, async () => ({ rewards: await store.listRewards() }));

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

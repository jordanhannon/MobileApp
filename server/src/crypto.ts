import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Algorithm, Version, hash, verify } from '@node-rs/argon2';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashEmailCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

export function createEmailCode(): string {
  return randomInt(10_000_000, 100_000_000).toString();
}

export function createId(): string {
  return randomUUID();
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password, { algorithm: Algorithm.Argon2id });
}

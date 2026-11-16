import type { Account, RedemptionResult, Reward, UserRecord } from './domain.js';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export interface Store {
  createUser(id: string, name: string, email: string, passwordHash: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  issueEmailToken(userId: string, purpose: EmailTokenPurpose, tokenHash: string, expiresAt: Date): Promise<void>;
  verifyEmail(email: string, tokenHash: string): Promise<boolean>;
  resetPassword(email: string, tokenHash: string, passwordHash: string): Promise<boolean>;
  createSession(
    id: string,
    userId: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account>;
  findAccountByAccessTokenHash(accessTokenHash: string): Promise<Account | null>;
  rotateSession(
    oldRefreshTokenHash: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account | null>;
  revokeSession(refreshTokenHash: string): Promise<void>;
  listRewards(): Promise<Reward[]>;
  redeem(userId: string, rewardId: string, idempotencyKey: string): Promise<RedemptionResult>;
}

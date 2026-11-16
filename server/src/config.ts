export type AppConfig = {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  tokenHashSecret: string;
  allowedOrigins: string[];
  accessTokenMinutes: number;
  refreshTokenDays: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  emailFrom: string;
  sessionCookieName: string;
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const tokenHashSecret = env.TOKEN_HASH_SECRET ?? (
    nodeEnv === 'production' ? '' : 'development-only-token-hash-secret'
  );
  if (tokenHashSecret.length < 32) {
    throw new Error('TOKEN_HASH_SECRET must contain at least 32 characters.');
  }
  return {
    nodeEnv,
    port: positiveInteger(env.PORT, 3000, 'PORT'),
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL'),
    tokenHashSecret,
    allowedOrigins: (env.API_ORIGINS ?? 'http://localhost:8081,http://localhost:19006')
      .split(',')
      .map((origin: string) => origin.trim())
      .filter(Boolean),
    accessTokenMinutes: positiveInteger(env.ACCESS_TOKEN_MINUTES, 15, 'ACCESS_TOKEN_MINUTES'),
    refreshTokenDays: positiveInteger(env.REFRESH_TOKEN_DAYS, 30, 'REFRESH_TOKEN_DAYS'),
    smtpHost: env.SMTP_HOST ?? '',
    smtpPort: positiveInteger(env.SMTP_PORT, 587, 'SMTP_PORT'),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER ?? '',
    smtpPassword: env.SMTP_PASSWORD ?? '',
    emailFrom: env.SMTP_FROM ?? 'Green Fork <no-reply@example.com>',
    sessionCookieName: 'gf_refresh',
  };
}

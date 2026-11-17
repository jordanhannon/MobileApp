import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { SocialIdentityProvider } from './domain.js';

export type VerifiedSocialIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export interface SocialTokenVerifier {
  verify(
    provider: SocialIdentityProvider,
    token: string,
    nonce: string,
    audiences: string[],
  ): Promise<VerifiedSocialIdentity>;
}

export class InvalidSocialTokenError extends Error {
  constructor() {
    super('The identity provider token is invalid.');
    this.name = 'InvalidSocialTokenError';
  }
}

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

type ProviderKeySets = Record<SocialIdentityProvider, JWTVerifyGetKey>;

function isVerifiedEmail(value: unknown): boolean {
  return value === true || value === 'true';
}

export class OidcSocialTokenVerifier implements SocialTokenVerifier {
  constructor(
    private readonly keySets: ProviderKeySets = {
      google: googleKeys,
      apple: appleKeys,
    },
  ) {}

  async verify(
    provider: SocialIdentityProvider,
    token: string,
    nonce: string,
    audiences: string[],
  ): Promise<VerifiedSocialIdentity> {
    if (audiences.length === 0) throw new Error(`No ${provider} client IDs are configured.`);

    let payload;
    try {
      const verified = await jwtVerify(token, this.keySets[provider], {
        issuer: provider === 'google'
          ? ['https://accounts.google.com', 'accounts.google.com']
          : 'https://appleid.apple.com',
        audience: audiences,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        clockTolerance: 5,
      });
      payload = verified.payload;
    } catch (error) {
      if (error instanceof errors.JOSEError) throw new InvalidSocialTokenError();
      throw error;
    }

    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.sub.length > 255 ||
      payload.nonce !== nonce
    ) {
      throw new InvalidSocialTokenError();
    }

    const email = typeof payload.email === 'string' && payload.email.length <= 320
      ? payload.email
      : null;
    const name = typeof payload.name === 'string' && payload.name.length <= 100
      ? payload.name
      : null;

    return {
      subject: payload.sub,
      email,
      emailVerified: isVerifiedEmail(payload.email_verified),
      name,
    };
  }
}

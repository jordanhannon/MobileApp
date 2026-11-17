import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  createLocalJWKSet, exportJWK, generateKeyPair, SignJWT,
} from 'jose';
import type { JWK } from 'jose';
import { InvalidSocialTokenError, OidcSocialTokenVerifier } from '../src/socialAuth.js';

test('Google and Apple identity tokens require trusted issuer, audience, and matching nonce', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const exportedKey = await exportJWK(publicKey);
  const signingKey: JWK = { ...exportedKey, kid: 'social-auth-test-key', alg: 'RS256', use: 'sig' };
  const localKeys = createLocalJWKSet({ keys: [signingKey] });
  const verifier = new OidcSocialTokenVerifier({ google: localKeys, apple: localKeys });
  const nonce = 'server-issued-one-time-nonce';

  const googleToken = await new SignJWT({
    email: 'google@example.test',
    email_verified: true,
    name: 'Google Member',
    nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
    .setIssuer('https://accounts.google.com')
    .setAudience('google-client-id')
    .setSubject('google-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  assert.deepEqual(
    await verifier.verify('google', googleToken, nonce, ['google-client-id']),
    {
      subject: 'google-subject',
      email: 'google@example.test',
      emailVerified: true,
      name: 'Google Member',
    },
  );
  await assert.rejects(
    () => verifier.verify('google', googleToken, 'different-nonce', ['google-client-id']),
    InvalidSocialTokenError,
  );
  await assert.rejects(
    () => verifier.verify('google', googleToken, nonce, ['other-google-client']),
    InvalidSocialTokenError,
  );

  const appleToken = await new SignJWT({
    email: 'relay@privaterelay.appleid.com',
    email_verified: 'true',
    nonce,
  })
    .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
    .setIssuer('https://appleid.apple.com')
    .setAudience('com.greenfork.rewards')
    .setSubject('apple-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  assert.deepEqual(
    await verifier.verify('apple', appleToken, nonce, ['com.greenfork.rewards']),
    {
      subject: 'apple-subject',
      email: 'relay@privaterelay.appleid.com',
      emailVerified: true,
      name: null,
    },
  );
  await assert.rejects(
    () => verifier.verify('apple', appleToken, nonce, ['com.other.app']),
    InvalidSocialTokenError,
  );
});

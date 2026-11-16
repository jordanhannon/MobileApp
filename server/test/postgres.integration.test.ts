import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { PostgresStore } from '../src/postgresStore.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL persists accounts, sessions, tokens, and atomic redemptions', {
  skip: !connectionString,
}, async () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresStore(pool);
  const userId = randomUUID();
  const email = `integration-${userId}@example.test`;
  const tokenHash = () => randomBytes(32).toString('hex');
  let userCreated = false;

  try {
    const user = await store.createUser(userId, 'Integration Member', email, 'argon2-hash');
    assert.ok(user);
    userCreated = true;
    assert.equal(await store.createUser(randomUUID(), 'Duplicate', email.toUpperCase(), 'hash'), null);
    assert.equal((await store.findUserByEmail(email))?.id, userId);

    const verificationHash = tokenHash();
    await store.issueEmailToken(userId, 'verify_email', verificationHash, new Date(Date.now() + 60_000));
    assert.equal(await store.verifyEmail(email, verificationHash), true);
    assert.ok((await store.findUserByEmail(email))?.emailVerifiedAt);

    const accessHash = tokenHash();
    const refreshHash = tokenHash();
    const account = await store.createSession(
      randomUUID(),
      userId,
      accessHash,
      refreshHash,
      new Date(Date.now() + 15 * 60_000),
      new Date(Date.now() + 30 * 24 * 60 * 60_000),
    );
    assert.equal(account.rewardPoints, 0);
    assert.equal((await store.findAccountByAccessTokenHash(accessHash))?.id, userId);

    const resetHash = tokenHash();
    await store.issueEmailToken(userId, 'reset_password', resetHash, new Date(Date.now() + 60_000));
    assert.equal(await store.resetPassword(email, resetHash, 'new-argon2-hash'), true);
    assert.equal(await store.findAccountByAccessTokenHash(accessHash), null);

    await pool.query(
      `INSERT INTO points_ledger (id, user_id, delta, entry_type)
       VALUES ($1, $2, $3, 'admin_credit')`,
      [randomUUID(), userId, 250],
    );

    const coffee = await store.redeem(userId, 'coffee', 'integration-coffee');
    assert.equal(coffee.kind, 'redeemed');
    if (coffee.kind !== 'redeemed') return;
    assert.equal(coffee.balance, 150);
    assert.equal(coffee.alreadyApplied, false);

    const duplicateCoffee = await store.redeem(userId, 'coffee', 'integration-coffee');
    assert.equal(duplicateCoffee.kind, 'redeemed');
    if (duplicateCoffee.kind !== 'redeemed') return;
    assert.equal(duplicateCoffee.redemptionId, coffee.redemptionId);
    assert.equal(duplicateCoffee.balance, 150);
    assert.equal(duplicateCoffee.alreadyApplied, true);

    const pastry = await store.redeem(userId, 'pastry', 'integration-pastry');
    assert.equal(pastry.kind, 'redeemed');
    if (pastry.kind !== 'redeemed') return;
    assert.equal(pastry.balance, 0);

    assert.deepEqual(await store.redeem(userId, 'lunch', 'integration-lunch'), {
      kind: 'insufficient_points',
      balance: 0,
    });
    assert.deepEqual(await store.redeem(userId, 'unknown', 'integration-unknown'), {
      kind: 'reward_unavailable',
    });
  } finally {
    if (userCreated) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
});

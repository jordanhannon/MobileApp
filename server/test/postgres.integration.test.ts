import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { test } from 'node:test';
import { PostgresStore } from '../src/postgresStore.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL persists auth, roles, reporting, RSVPs, audited management, and redemptions', {
  skip: !connectionString,
}, async () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresStore(pool);
  const userId = randomUUID();
  const adminId = randomUUID();
  const email = `integration-${userId}@example.test`;
  const adminEmail = `integration-admin-${adminId}@example.test`;
  const eventId = `integration-${userId.slice(0, 8)}`;
  const monthlyEventId = `monthly-${userId.slice(0, 8)}`;
  const rewardId = `integration-${userId.slice(0, 8)}`;
  const tokenHash = () => randomBytes(32).toString('hex');

  try {
    const user = await store.createUser(userId, 'Integration Member', email, 'argon2-hash');
    assert.ok(user);
    assert.equal(user.role, 'member');
    const admin = await store.createUser(adminId, 'Integration Admin', adminEmail, 'argon2-hash');
    assert.ok(admin);
    await pool.query('UPDATE users SET role = $2 WHERE id = $1', [adminId, 'admin']);
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
    assert.equal(account.role, 'member');
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
    const initialSummary = await store.getPointsSummary();
    assert.ok(initialSummary.totalUsers >= 2);
    assert.ok(initialSummary.totalPoints >= 250);
    assert.equal((await store.getUserPoints(userId, 10, 0)).balance, 250);

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

    await store.createEvent(adminId, {
      id: eventId,
      title: 'Integration Event',
      startsAt: '2027-03-07T16:30:00.000Z',
      description: 'Capacity and attendee test.',
      tag: 'TEST',
      capacity: 1,
      rsvpOpen: true,
      recurrence: 'weekly',
      recurrenceUntil: null,
    });
    const firstOccurrence = '2027-03-07T16:30:00.000Z';
    const secondOccurrence = '2027-03-14T15:30:00.000Z';
    const rsvpAttempts = await Promise.allSettled([
      store.rsvpToEvent(userId, eventId, firstOccurrence),
      store.rsvpToEvent(adminId, eventId, firstOccurrence),
    ]);
    assert.equal(
      rsvpAttempts.filter(result => result.status === 'fulfilled' && result.value === 'rsvped').length,
      1,
    );
    assert.equal(
      rsvpAttempts.filter(result => result.status === 'rejected' && result.reason.code === 'event_full').length,
      1,
    );
    const firstOccurrenceWinner = rsvpAttempts[0].status === 'fulfilled' ? userId : adminId;
    const secondOccurrenceUser = firstOccurrenceWinner === userId ? adminId : userId;
    assert.equal(await store.rsvpToEvent(secondOccurrenceUser, eventId, secondOccurrence), 'rsvped');
    const eventList = await store.listEvents(userId);
    const event = eventList.find(item => item.id === eventId && item.occurrenceStart === firstOccurrence);
    assert.equal(event?.reserved, firstOccurrenceWinner === userId);
    assert.ok(eventList.some(item => item.id === eventId && item.occurrenceStart === secondOccurrence));
    const attendees = await store.listEventAttendees(eventId, firstOccurrence, 10, 0);
    assert.equal(attendees.total, 1);
    assert.ok(['Integration Member', 'Integration Admin'].includes(attendees.attendees[0].name));
    assert.equal('email' in attendees.attendees[0], false);
    const secondAttendees = await store.listEventAttendees(eventId, secondOccurrence, 10, 0);
    assert.equal(secondAttendees.total, 1);
    await assert.rejects(
      () => store.updateEvent(adminId, eventId, {
        id: eventId,
        title: 'Updated Integration Event',
        startsAt: '2027-03-07T17:30:00.000Z',
        description: 'Updated capacity and attendee test.',
        tag: 'TEST',
        capacity: 1,
        rsvpOpen: true,
        recurrence: 'weekly',
        recurrenceUntil: null,
      }),
      { code: 'event_schedule_conflict' },
    );

    await store.updateEvent(adminId, eventId, {
      id: eventId,
      title: 'Updated Integration Event',
      startsAt: '2027-03-07T16:30:00.000Z',
      description: 'Updated capacity and attendee test.',
      tag: 'TEST',
      capacity: 1,
      rsvpOpen: false,
      recurrence: 'weekly',
      recurrenceUntil: null,
    });
    assert.equal((await store.listAdminEvents()).find(item => item.id === eventId)?.rsvpOpen, false);
    await store.archiveEvent(adminId, eventId);
    assert.equal((await store.listAdminEvents()).find(item => item.id === eventId)?.active, false);

    await store.createEvent(adminId, {
      id: monthlyEventId,
      title: 'Integration Monthly Event',
      startsAt: '2027-01-31T16:00:00.000Z',
      description: 'Monthly recurrence end-of-month test.',
      tag: 'TEST',
      capacity: null,
      rsvpOpen: true,
      recurrence: 'monthly',
      recurrenceUntil: '2027-04-30',
    });
    assert.equal(
      (await store.listAdminEvents()).find(item => item.id === monthlyEventId)?.recurrenceUntil,
      '2027-04-30',
    );
    const monthlyOccurrences = (await store.listEvents(userId))
      .filter(item => item.id === monthlyEventId)
      .map(item => item.occurrenceStart);
    assert.deepEqual(monthlyOccurrences, [
      '2027-01-31T16:00:00.000Z',
      '2027-02-28T16:00:00.000Z',
      '2027-03-31T15:00:00.000Z',
      '2027-04-30T15:00:00.000Z',
    ]);
    assert.equal(
      await store.rsvpToEvent(userId, monthlyEventId, '2027-02-28T16:00:00.000Z'),
      'rsvped',
    );
    await assert.rejects(
      () => store.rsvpToEvent(userId, monthlyEventId, '2027-04-29T16:00:00.000Z'),
      { code: 'event_occurrence_not_found' },
    );

    await store.assignUserRole(adminId, userId, 'staff');
    assert.equal((await store.findUserByEmail(email))?.role, 'staff');
    const search = await store.searchUsers('integration-', 10, 0);
    assert.ok(search.users.some(item => item.id === userId && item.role === 'staff'));
    assert.equal((await store.getUserPoints(userId, 10, 0)).balance, 0);

    const createdReward = await store.createReward(adminId, {
      id: rewardId,
      name: 'Integration Reward',
      pointsCost: 50,
      icon: '🎁',
    });
    assert.equal(createdReward.active, true);
    const updatedReward = await store.updateReward(adminId, rewardId, {
      name: 'Updated Integration Reward',
      pointsCost: 75,
      icon: '🎁',
    });
    assert.equal(updatedReward.pointsCost, 75);
    await store.archiveReward(adminId, rewardId);
    assert.equal((await store.listAdminRewards()).find(item => item.id === rewardId)?.active, false);

    const audit = await pool.query<{ total: string }>(
      'SELECT COUNT(*)::TEXT AS total FROM admin_audit_log WHERE actor_user_id = $1',
      [adminId],
    );
    assert.ok(Number(audit.rows[0].total) >= 7);
  } finally {
    await pool.query('DELETE FROM admin_audit_log WHERE actor_user_id = ANY($1::UUID[])', [[userId, adminId]]);
    await pool.query('DELETE FROM event_rsvps WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM event_rsvps WHERE event_id = $1', [monthlyEventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [monthlyEventId]);
    await pool.query('DELETE FROM rewards WHERE id = $1', [rewardId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::UUID[])', [[userId, adminId]]);
    await pool.end();
  }
});

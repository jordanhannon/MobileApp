import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExpoReceipt, PushDelivery } from '../src/domain.js';
import { runNotificationDeliveryCycle } from '../src/notificationDelivery.js';

function delivery(id: string): PushDelivery {
  return {
    id,
    notificationId: 'notification-id',
    token: 'ExponentPushToken[test-device-token]',
    title: 'Event reminder',
    body: 'Your event is coming up.',
    data: { screen: 'Events', eventId: 'pool-night' },
    attemptCount: 1,
  };
}

function storeWith(
  deliveries: PushDelivery[],
  receipts: ExpoReceipt[] = [],
) {
  const submitted: Array<{ deliveryId: string; ticketId: string }> = [];
  const retries: Array<{ deliveryId: string; error: string; delay: number }> = [];
  const failures: Array<{ deliveryId: string; error: string; deactivateToken: boolean }> = [];
  const delivered: string[] = [];
  return {
    submitted,
    retries,
    failures,
    delivered,
    store: {
      async claimPushDeliveries() { return deliveries; },
      async markPushDeliverySubmitted(deliveryId: string, ticketId: string) {
        submitted.push({ deliveryId, ticketId });
      },
      async retryPushDelivery(deliveryId: string, error: string, delay: number) {
        retries.push({ deliveryId, error, delay });
      },
      async failPushDelivery(deliveryId: string, error: string, deactivateToken: boolean) {
        failures.push({ deliveryId, error, deactivateToken });
      },
      async listDueExpoReceipts() { return receipts; },
      async markExpoReceiptDelivered(deliveryId: string) { delivered.push(deliveryId); },
      async markExpoReceiptFailed(deliveryId: string, error: string, deactivateToken: boolean) {
        failures.push({ deliveryId, error, deactivateToken });
      },
    },
  };
}

test('Expo push tickets and receipts are processed without exposing token data', async () => {
  const receipt: ExpoReceipt = { id: 'delivery-id', ticketId: 'expo-ticket-id', attemptCount: 1 };
  const fake = storeWith([delivery('delivery-id')], [receipt]);
  const requests: Array<{ url: string; headers: HeadersInit; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ url, headers: init?.headers ?? {}, body });
    if (url.endsWith('/push/send')) {
      return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'expo-ticket-id' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { 'expo-ticket-id': { status: 'ok' } } }), { status: 200 });
  };

  await runNotificationDeliveryCycle(fake.store, 'server-only-token', fetcher);

  assert.deepEqual(fake.submitted, [{ deliveryId: 'delivery-id', ticketId: 'expo-ticket-id' }]);
  assert.deepEqual(fake.delivered, ['delivery-id']);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].body)[0].data.notificationId, 'notification-id');
  assert.equal(new Headers(requests[0].headers).get('authorization'), 'Bearer server-only-token');
  assert.equal(requests[0].body.includes('server-only-token'), false);
  assert.equal(requests[0].body.includes('ExponentPushToken'), true);
});

test('Expo invalid-device tickets deactivate the token', async () => {
  const fake = storeWith([delivery('invalid-device')]);
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
  }), { status: 200 });

  await runNotificationDeliveryCycle(fake.store, undefined, fetcher);

  assert.equal(fake.failures.length, 1);
  assert.equal(fake.failures[0].deliveryId, 'invalid-device');
  assert.equal(fake.failures[0].deactivateToken, true);
  assert.equal(fake.retries.length, 0);
});

test('temporary Expo failures are retried and surfaced to the worker logger', async () => {
  const fake = storeWith([delivery('temporary-failure')]);
  const fetcher: typeof fetch = async () => new Response('', { status: 503 });

  await assert.rejects(
    () => runNotificationDeliveryCycle(fake.store, undefined, fetcher),
    /HTTP 503/,
  );
  assert.deepEqual(fake.retries, [{
    deliveryId: 'temporary-failure',
    error: 'Expo push service returned HTTP 503.',
    delay: 30,
  }]);
});

import type { ExpoReceipt, PushDelivery } from './domain.js';
import type { Store } from './store.js';

type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

type ExpoReceiptResult =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

type NotificationDeliveryStore = Pick<
  Store,
  | 'claimPushDeliveries'
  | 'markPushDeliverySubmitted'
  | 'retryPushDelivery'
  | 'failPushDelivery'
  | 'listDueExpoReceipts'
  | 'markExpoReceiptDelivered'
  | 'markExpoReceiptFailed'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryDelay(attemptCount: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attemptCount - 1));
}

async function retryBatch(store: NotificationDeliveryStore, deliveries: PushDelivery[], reason: string): Promise<void> {
  await Promise.all(deliveries.map(delivery =>
    store.retryPushDelivery(delivery.id, reason, retryDelay(delivery.attemptCount))));
}

function expoHeaders(accessToken?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function sendPushBatch(
  store: NotificationDeliveryStore,
  deliveries: PushDelivery[],
  accessToken: string | undefined,
  fetcher: typeof fetch,
): Promise<void> {
  if (deliveries.length === 0) return;
  let response: Response;
  try {
    response = await fetcher('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: expoHeaders(accessToken),
      body: JSON.stringify(deliveries.map(delivery => ({
        to: delivery.token,
        title: delivery.title,
        body: delivery.body,
        data: { ...delivery.data, notificationId: delivery.notificationId },
        sound: 'default',
      }))),
    });
  } catch {
    await retryBatch(store, deliveries, 'Expo push request failed before a response was received.');
    throw new Error('Expo push request failed before a response was received.');
  }

  if (!response.ok) {
    const reason = `Expo push service returned HTTP ${response.status}.`;
    if (response.status === 429 || response.status >= 500) {
      await retryBatch(store, deliveries, reason);
    } else {
      await Promise.all(deliveries.map(delivery =>
        store.failPushDelivery(delivery.id, reason, false)));
    }
    throw new Error(reason);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    await retryBatch(store, deliveries, 'Expo push service returned invalid JSON.');
    throw new Error('Expo push service returned invalid JSON.');
  }
  const tickets = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (!tickets || tickets.length !== deliveries.length) {
    await retryBatch(store, deliveries, 'Expo push service returned an unexpected ticket count.');
    throw new Error('Expo push service returned an unexpected ticket count.');
  }

  await Promise.all(deliveries.map(async (delivery, index) => {
    const ticket = tickets[index];
    if (!isRecord(ticket)) {
      await store.retryPushDelivery(
        delivery.id,
        'Expo push service returned a malformed ticket.',
        retryDelay(delivery.attemptCount),
      );
      return;
    }
    if (ticket.status === 'ok' && typeof ticket.id === 'string') {
      await store.markPushDeliverySubmitted(delivery.id, ticket.id);
      return;
    }
    const details = isRecord(ticket.details) ? ticket.details : {};
    const errorCode = typeof details.error === 'string' ? details.error : 'ExpoTicketError';
    const message = typeof ticket.message === 'string' ? ticket.message : errorCode;
    if (errorCode === 'MessageRateExceeded') {
      await store.retryPushDelivery(delivery.id, message, retryDelay(delivery.attemptCount));
    } else {
      await store.failPushDelivery(delivery.id, `${errorCode}: ${message}`, errorCode === 'DeviceNotRegistered');
    }
  }));
}

async function processReceipts(
  store: NotificationDeliveryStore,
  receipts: ExpoReceipt[],
  accessToken: string | undefined,
  fetcher: typeof fetch,
): Promise<void> {
  if (receipts.length === 0) return;
  let response: Response;
  try {
    response = await fetcher('https://exp.host/--/api/v2/push/getReceipts', {
      method: 'POST',
      headers: expoHeaders(accessToken),
      body: JSON.stringify({ ids: receipts.map(receipt => receipt.ticketId) }),
    });
  } catch {
    throw new Error('Unable to request Expo push receipts.');
  }
  if (!response.ok) throw new Error(`Expo receipt service returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  const receiptData = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!receiptData) throw new Error('Expo receipt service returned an unexpected response.');

  await Promise.all(receipts.flatMap(receipt => {
    const result = receiptData[receipt.ticketId];
    if (!isRecord(result)) return [];
    if (result.status === 'ok') {
      return [store.markExpoReceiptDelivered(receipt.id)];
    }
    if (result.status === 'error') {
      const details = isRecord(result.details) ? result.details : {};
      const errorCode = typeof details.error === 'string' ? details.error : 'ExpoReceiptError';
      const message = typeof result.message === 'string' ? result.message : errorCode;
      return [store.markExpoReceiptFailed(
        receipt.id,
        `${errorCode}: ${message}`,
        errorCode === 'DeviceNotRegistered',
      )];
    }
    return [];
  }));
}

export async function runNotificationDeliveryCycle(
  store: NotificationDeliveryStore,
  accessToken?: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const deliveries = await store.claimPushDeliveries(100);
  await sendPushBatch(store, deliveries, accessToken, fetcher);
  const receipts: ExpoReceipt[] = await store.listDueExpoReceipts(300);
  await processReceipts(store, receipts, accessToken, fetcher);
}

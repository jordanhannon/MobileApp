import { apiRequest } from './auth';
import type { AppEvent } from './eventsApi';

export type StaffUser = {
  id: string;
  name: string;
  email: string;
  rewardPoints: number;
  role: 'member' | 'staff' | 'admin';
  emailVerifiedAt: string | null;
};

export type PointsSummary = {
  totalUsers: number;
  usersWithPoints: number;
  totalPoints: number;
};

export type LedgerEntry = {
  id: string;
  delta: number;
  entryType: string;
  referenceId: string | null;
  createdAt: string;
};

export type EventAttendee = {
  userId: string;
  name: string;
  rsvpAt: string;
};

export type ManagedEvent = Omit<AppEvent, 'attendeeCount' | 'reserved'>;

export type ManagedReward = {
  id: string;
  name: string;
  pointsCost: number;
  icon: string;
  active: boolean;
};

export type ManagedEventInput = {
  title: string;
  startsAt: string;
  description: string;
  tag: string;
  capacity: number | null;
  rsvpOpen: boolean;
  bracketEnabled: boolean;
  recurrence: 'none' | 'weekly' | 'monthly';
  recurrenceUntil: string | null;
};

export type ManagedRewardInput = Omit<ManagedReward, 'id' | 'active'>;

export type AnnouncementAudience =
  | { type: 'all' }
  | { type: 'event'; eventId: string; occurrenceStart: string };

export async function searchUsers(
  query: string,
  page = 1,
): Promise<{ users: StaffUser[]; total: number; page: number; pageSize: number }> {
  return apiRequest<{ users: StaffUser[]; total: number; page: number; pageSize: number }>(
    `/admin/users?q=${encodeURIComponent(query)}&page=${page}&pageSize=50`,
  );
}

export async function fetchPointsSummary(): Promise<PointsSummary> {
  const response = await apiRequest<{ summary: PointsSummary }>('/admin/points');
  return response.summary;
}

export async function publishAnnouncement(
  title: string,
  body: string,
  audience: AnnouncementAudience,
  idempotencyKey: string,
): Promise<{ recipients: number; alreadyApplied: boolean }> {
  return apiRequest('/admin/announcements', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: { title, body, audience },
  });
}

export async function fetchUserPoints(userId: string): Promise<{ balance: number; entries: LedgerEntry[] }> {
  return apiRequest<{ balance: number; entries: LedgerEntry[] }>(
    `/admin/users/${encodeURIComponent(userId)}/points?pageSize=25`,
  );
}

export async function fetchAttendees(
  eventId: string,
  occurrenceStart: string,
): Promise<{ event: ManagedEvent; total: number; attendees: EventAttendee[] }> {
  return apiRequest<{ event: ManagedEvent; total: number; attendees: EventAttendee[] }>(
    `/admin/events/${encodeURIComponent(eventId)}/attendees?pageSize=100&occurrenceStart=${encodeURIComponent(occurrenceStart)}`,
  );
}

export async function fetchManagedEvents(): Promise<ManagedEvent[]> {
  const response = await apiRequest<{ events: ManagedEvent[] }>('/admin/events');
  return response.events;
}

export async function createEvent(input: ManagedEventInput): Promise<ManagedEvent> {
  const response = await apiRequest<{ event: ManagedEvent }>('/admin/events', {
    method: 'POST',
    body: input,
  });
  return response.event;
}

export async function updateEvent(eventId: string, input: ManagedEventInput): Promise<ManagedEvent> {
  const response = await apiRequest<{ event: ManagedEvent }>(`/admin/events/${encodeURIComponent(eventId)}/update`, {
    method: 'POST',
    body: input,
  });
  return response.event;
}

export async function archiveEvent(eventId: string): Promise<void> {
  await apiRequest(`/admin/events/${encodeURIComponent(eventId)}/archive`, { method: 'POST', body: {} });
}

export async function fetchManagedRewards(): Promise<ManagedReward[]> {
  const response = await apiRequest<{ rewards: ManagedReward[] }>('/admin/rewards');
  return response.rewards;
}

export async function createReward(input: ManagedRewardInput): Promise<ManagedReward> {
  const response = await apiRequest<{ reward: ManagedReward }>('/admin/rewards', { method: 'POST', body: input });
  return response.reward;
}

export async function updateReward(rewardId: string, input: ManagedRewardInput): Promise<ManagedReward> {
  const response = await apiRequest<{ reward: ManagedReward }>(
    `/admin/rewards/${encodeURIComponent(rewardId)}/update`,
    { method: 'POST', body: input },
  );
  return response.reward;
}

export async function archiveReward(rewardId: string): Promise<void> {
  await apiRequest(`/admin/rewards/${encodeURIComponent(rewardId)}/archive`, { method: 'POST', body: {} });
}

export async function assignRole(userId: string, role: StaffUser['role']): Promise<void> {
  await apiRequest(`/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'POST',
    body: { role },
  });
}

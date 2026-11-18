import { apiRequest } from './auth';

export type AppEvent = {
  id: string;
  title: string;
  startsAt: string;
  occurrenceStart: string;
  description: string;
  tag: string;
  capacity: number | null;
  rsvpOpen: boolean;
  bracketEnabled: boolean;
  bracketStatus: 'drawn' | 'completed' | null;
  recurrence: 'none' | 'weekly' | 'monthly';
  recurrenceUntil: string | null;
  active: boolean;
  attendeeCount: number;
  bracketParticipantCount: number;
  reserved: boolean;
};

export async function fetchEvents(): Promise<AppEvent[]> {
  const response = await apiRequest<{ events: AppEvent[] }>('/events');
  return response.events;
}

export async function fetchEventsForMonth(month: string): Promise<AppEvent[]> {
  const response = await apiRequest<{ events: AppEvent[] }>(`/events?month=${encodeURIComponent(month)}`);
  return response.events;
}

export async function rsvpToEvent(eventId: string, occurrenceStart: string): Promise<void> {
  await apiRequest(`/events/${encodeURIComponent(eventId)}/rsvp`, {
    method: 'POST',
    body: { occurrenceStart },
  });
}

export async function cancelEventRsvp(eventId: string, occurrenceStart: string): Promise<void> {
  await apiRequest(`/events/${encodeURIComponent(eventId)}/cancel`, {
    method: 'POST',
    body: { occurrenceStart },
  });
}

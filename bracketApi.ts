import { apiRequest } from './auth';

export type BracketEntrant = {
  entrantId: string;
  userId: string | null;
  name: string;
  status: 'active' | 'waitlisted';
};

export type BracketPlayer = {
  entrantId: string;
  userId: string | null;
  name: string;
};

export type BracketMatch = {
  id: string;
  roundNumber: number;
  matchNumber: number;
  playerOne: BracketPlayer | null;
  playerTwo: BracketPlayer | null;
  winnerEntrantId: string | null;
};

export type TournamentBracket = {
  eventId: string;
  occurrenceStart: string;
  cutoffAt: string;
  participantCount: number;
  status: 'not_started' | 'drawn' | 'completed';
  randomizedAt: string | null;
  entrants: BracketEntrant[];
  rounds: BracketMatch[][];
  championEntrantId: string | null;
};

export type BracketGuest = {
  id: string;
  name: string;
  createdAt: string;
};

export async function fetchEventBracket(eventId: string, occurrenceStart: string): Promise<TournamentBracket> {
  const response = await apiRequest<{ bracket: TournamentBracket }>(
    `/events/${encodeURIComponent(eventId)}/bracket?occurrenceStart=${encodeURIComponent(occurrenceStart)}`,
  );
  return response.bracket;
}

export async function drawEventBracket(eventId: string, occurrenceStart: string): Promise<TournamentBracket> {
  const response = await apiRequest<{ bracket: TournamentBracket }>(
    `/admin/events/${encodeURIComponent(eventId)}/bracket/draw`,
    { method: 'POST', body: { occurrenceStart } },
  );
  return response.bracket;
}

export async function recordBracketWinner(
  eventId: string,
  occurrenceStart: string,
  matchId: string,
  winnerEntrantId: string,
): Promise<TournamentBracket> {
  const response = await apiRequest<{ bracket: TournamentBracket }>(
    `/admin/events/${encodeURIComponent(eventId)}/bracket/matches/${encodeURIComponent(matchId)}/winner`,
    { method: 'POST', body: { occurrenceStart, winnerEntrantId } },
  );
  return response.bracket;
}

export async function fetchBracketGuests(eventId: string, occurrenceStart: string): Promise<BracketGuest[]> {
  const response = await apiRequest<{ guests: BracketGuest[] }>(
    `/admin/events/${encodeURIComponent(eventId)}/bracket/guests?occurrenceStart=${encodeURIComponent(occurrenceStart)}`,
  );
  return response.guests;
}

export async function addBracketGuest(eventId: string, occurrenceStart: string, name: string): Promise<BracketGuest> {
  const response = await apiRequest<{ guest: BracketGuest }>(
    `/admin/events/${encodeURIComponent(eventId)}/bracket/guests`,
    { method: 'POST', body: { occurrenceStart, name } },
  );
  return response.guest;
}

export async function removeBracketGuest(
  eventId: string,
  occurrenceStart: string,
  guestId: string,
): Promise<void> {
  await apiRequest(
    `/admin/events/${encodeURIComponent(eventId)}/bracket/guests/${encodeURIComponent(guestId)}/remove`,
    {
    method: 'POST',
    body: { occurrenceStart },
    },
  );
}

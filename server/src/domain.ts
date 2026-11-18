export type UserRole = 'member' | 'staff' | 'admin';
export type SocialIdentityProvider = 'google' | 'apple';

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  role: UserRole;
};

export type SocialIdentityInput = {
  id: string;
  provider: SocialIdentityProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  nonceHash: string;
};

export type SocialIdentityResult =
  | { kind: 'authenticated'; user: UserRecord }
  | { kind: 'profile_required' };

export type Account = {
  id: string;
  name: string;
  email: string;
  rewardPoints: number;
  role: UserRole;
};

export type Reward = {
  id: string;
  name: string;
  pointsCost: number;
  icon: string;
};

export type RedemptionResult =
  | { kind: 'redeemed'; redemptionId: string; reward: Reward; balance: number; alreadyApplied: boolean }
  | { kind: 'insufficient_points'; balance: number }
  | { kind: 'reward_unavailable' };

export type EventRecord = {
  id: string;
  title: string;
  startsAt: string;
  description: string;
  tag: string;
  capacity: number | null;
  rsvpOpen: boolean;
  bracketEnabled: boolean;
  recurrence: 'none' | 'weekly' | 'monthly';
  recurrenceUntil: string | null;
  active: boolean;
};

export type MemberEvent = EventRecord & {
  occurrenceStart: string;
  attendeeCount: number;
  bracketParticipantCount: number;
  reserved: boolean;
  bracketStatus: 'drawn' | 'completed' | null;
};

export type EventInput = Omit<EventRecord, 'active'>;

export type EventAttendee = {
  userId: string;
  name: string;
  rsvpAt: string;
};

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

export type AdminUser = Account & {
  emailVerifiedAt: string | null;
};

export type PointsSummary = {
  totalUsers: number;
  usersWithPoints: number;
  totalPoints: number;
};

export type PointsLedgerEntry = {
  id: string;
  delta: number;
  entryType: string;
  referenceId: string | null;
  createdAt: string;
};

export type NotificationType =
  | 'rsvp_confirmed'
  | 'rsvp_cancelled'
  | 'event_reminder'
  | 'event_changed'
  | 'event_cancelled'
  | 'points_earned'
  | 'reward_redeemed'
  | 'announcement';

export type AppNotification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, string>;
  createdAt: string;
  readAt: string | null;
};

export type NotificationPage = {
  items: AppNotification[];
  total: number;
  unreadCount: number;
};

export type NotificationPreferences = {
  rsvpUpdatesEnabled: boolean;
  eventChangesEnabled: boolean;
  rewardsEnabled: boolean;
  announcementsEnabled: boolean;
  pushEnabled: boolean;
  reminderSchedule: 'off' | '24h' | '1h' | '24h_1h';
};

export type PushPlatform = 'ios' | 'android';

export type PushDelivery = {
  id: string;
  notificationId: string;
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  attemptCount: number;
};

export type ExpoReceipt = {
  id: string;
  ticketId: string;
  attemptCount: number;
};

export type AnnouncementAudience =
  | { type: 'all' }
  | { type: 'event'; eventId: string; occurrenceStart: string };

export type AdminReward = Reward & {
  active: boolean;
};

export class StoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

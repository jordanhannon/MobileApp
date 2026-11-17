export type UserRole = 'member' | 'staff' | 'admin';

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  role: UserRole;
};

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
  recurrence: 'none' | 'weekly' | 'monthly';
  recurrenceUntil: string | null;
  active: boolean;
};

export type MemberEvent = EventRecord & {
  occurrenceStart: string;
  attendeeCount: number;
  reserved: boolean;
};

export type EventInput = Omit<EventRecord, 'active'>;

export type EventAttendee = {
  userId: string;
  name: string;
  rsvpAt: string;
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

export type AdminReward = Reward & {
  active: boolean;
};

export class StoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

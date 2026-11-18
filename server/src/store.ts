import type {
  Account, AdminReward, AdminUser, AnnouncementAudience, AppNotification, BracketGuest, BracketMatch,
  EventAttendee, EventInput, EventRecord, ExpoReceipt, MemberEvent, NotificationPage,
  NotificationPreferences, PushDelivery, PushPlatform,
  PointsLedgerEntry, PointsSummary, RedemptionResult, Reward, SocialIdentityInput,
  SocialIdentityProvider, SocialIdentityResult, TournamentBracket, UserRecord, UserRole,
} from './domain.js';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export interface Store {
  createUser(id: string, name: string, email: string, passwordHash: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  issueSocialNonce(provider: SocialIdentityProvider, nonceHash: string, expiresAt: Date): Promise<void>;
  resolveSocialIdentity(input: SocialIdentityInput): Promise<SocialIdentityResult>;
  issueEmailToken(userId: string, purpose: EmailTokenPurpose, tokenHash: string, expiresAt: Date): Promise<void>;
  verifyEmail(email: string, tokenHash: string): Promise<boolean>;
  resetPassword(email: string, tokenHash: string, passwordHash: string): Promise<boolean>;
  createSession(
    id: string,
    userId: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account>;
  findAccountByAccessTokenHash(accessTokenHash: string): Promise<Account | null>;
  rotateSession(
    oldRefreshTokenHash: string,
    accessTokenHash: string,
    refreshTokenHash: string,
    accessExpiresAt: Date,
    refreshExpiresAt: Date,
  ): Promise<Account | null>;
  revokeSession(refreshTokenHash: string): Promise<void>;
  listRewards(): Promise<Reward[]>;
  redeem(userId: string, rewardId: string, idempotencyKey: string): Promise<RedemptionResult>;
  listNotifications(userId: string, limit: number, offset: number): Promise<NotificationPage>;
  markNotificationRead(userId: string, notificationId: string): Promise<boolean>;
  markAllNotificationsRead(userId: string): Promise<number>;
  getNotificationPreferences(userId: string): Promise<NotificationPreferences>;
  updateNotificationPreferences(userId: string, preferences: NotificationPreferences): Promise<NotificationPreferences>;
  registerPushToken(userId: string, token: string, platform: PushPlatform): Promise<void>;
  revokePushToken(userId: string, token: string): Promise<void>;
  createAnnouncement(
    actorId: string,
    title: string,
    body: string,
    audience: AnnouncementAudience,
    idempotencyKey: string,
  ): Promise<{ recipients: number; alreadyApplied: boolean }>;
  enqueueDueEventReminders(): Promise<void>;
  claimPushDeliveries(limit: number): Promise<PushDelivery[]>;
  markPushDeliverySubmitted(deliveryId: string, ticketId: string): Promise<void>;
  retryPushDelivery(deliveryId: string, error: string, delaySeconds: number): Promise<void>;
  failPushDelivery(deliveryId: string, error: string, deactivateToken: boolean): Promise<void>;
  listDueExpoReceipts(limit: number): Promise<ExpoReceipt[]>;
  markExpoReceiptDelivered(deliveryId: string): Promise<void>;
  markExpoReceiptFailed(deliveryId: string, error: string, deactivateToken: boolean): Promise<void>;
  cleanupNotifications(): Promise<void>;
  listEvents(userId: string): Promise<MemberEvent[]>;
  listEventsForMonth(userId: string, monthStart: string): Promise<MemberEvent[]>;
  rsvpToEvent(userId: string, eventId: string, occurrenceStart: string): Promise<'rsvped' | 'already_rsvped'>;
  cancelEventRsvp(userId: string, eventId: string, occurrenceStart: string): Promise<boolean>;
  getEventBracket(eventId: string, occurrenceStart: string): Promise<TournamentBracket>;
  finalizeDueBrackets(): Promise<void>;
  drawEventBracket(actorId: string | null, eventId: string, occurrenceStart: string): Promise<TournamentBracket>;
  listBracketGuests(eventId: string, occurrenceStart: string): Promise<BracketGuest[]>;
  addBracketGuest(actorId: string, eventId: string, occurrenceStart: string, name: string): Promise<BracketGuest>;
  removeBracketGuest(actorId: string, eventId: string, occurrenceStart: string, guestId: string): Promise<void>;
  recordBracketWinner(
    actorId: string,
    eventId: string,
    occurrenceStart: string,
    matchId: string,
    winnerEntrantId: string,
  ): Promise<TournamentBracket>;
  listEventAttendees(eventId: string, occurrenceStart: string, limit: number, offset: number): Promise<{
    event: EventRecord;
    total: number;
    attendees: EventAttendee[];
  }>;
  searchUsers(query: string, limit: number, offset: number): Promise<{ users: AdminUser[]; total: number }>;
  getPointsSummary(): Promise<PointsSummary>;
  getUserPoints(userId: string, limit: number, offset: number): Promise<{
    balance: number;
    entries: PointsLedgerEntry[];
    total: number;
  }>;
  listAdminEvents(): Promise<EventRecord[]>;
  listAdminRewards(): Promise<AdminReward[]>;
  createEvent(actorId: string, input: EventInput): Promise<EventRecord>;
  updateEvent(actorId: string, eventId: string, input: EventInput): Promise<EventRecord>;
  archiveEvent(actorId: string, eventId: string): Promise<void>;
  createReward(actorId: string, reward: Reward): Promise<AdminReward>;
  updateReward(actorId: string, rewardId: string, reward: Omit<Reward, 'id'>): Promise<AdminReward>;
  archiveReward(actorId: string, rewardId: string): Promise<void>;
  assignUserRole(actorId: string, userId: string, role: UserRole): Promise<void>;
}

export type UserRecord = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
};

export type Account = {
  id: string;
  name: string;
  email: string;
  rewardPoints: number;
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

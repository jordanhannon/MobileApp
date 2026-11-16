import { apiRequest } from './auth';

export type Reward = {
  id: string;
  name: string;
  pointsCost: number;
  icon: string;
};

export type RedemptionResponse = {
  redemptionId: string;
  reward: Reward;
  rewardPoints: number;
  alreadyApplied: boolean;
};

export async function fetchRewards(): Promise<Reward[]> {
  const response = await apiRequest<{ rewards: Reward[] }>('/rewards');
  return response.rewards;
}

export function redeemReward(rewardId: string, idempotencyKey: string): Promise<RedemptionResponse> {
  return apiRequest<RedemptionResponse>('/redemptions', {
    method: 'POST',
    body: { rewardId },
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

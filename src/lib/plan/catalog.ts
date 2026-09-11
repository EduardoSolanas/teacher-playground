import { FREE_MAX_ROOMS, FREE_MAX_USERS } from './limits';

export type PlanId = 'free' | 'tutor_pro_monthly' | 'tutor_pro_annual' | 'corporate_seat';
export interface PlanDefinition {
  limits: { maxOwnedRooms: number; maxUsersPerRoom: number; retentionDays: number };
  interval: 'month' | 'year' | null;
  priceEnv: string | null;            // env var holding the Stripe price id
  minSeats?: number;                  // corporate: 3
}
export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  free:               { limits: { maxOwnedRooms: FREE_MAX_ROOMS, maxUsersPerRoom: FREE_MAX_USERS, retentionDays: 90 }, interval: null, priceEnv: null },
  tutor_pro_monthly:  { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'month', priceEnv: 'STRIPE_PRICE_TUTOR_PRO_MONTHLY' },
  tutor_pro_annual:   { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'year',  priceEnv: 'STRIPE_PRICE_TUTOR_PRO_ANNUAL' },
  corporate_seat:     { limits: { maxOwnedRooms: 20, maxUsersPerRoom: 10, retentionDays: 90 }, interval: 'year',  priceEnv: 'STRIPE_PRICE_CORPORATE_SEAT', minSeats: 3 },
};

// Copy/validation only; amounts live in Stripe as a graduated tiered price.
export const CORPORATE_SEAT_BANDS = [
  { min: 3,  max: 9,   gbpPerSeatMonth: 7.5 },
  { min: 10, max: 24,  gbpPerSeatMonth: 6.5 },
  { min: 25, max: 99,  gbpPerSeatMonth: 5.5 },
] as const;

export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;  // SEC-015 7-day grace

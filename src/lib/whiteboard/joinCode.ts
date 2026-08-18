import { isValidRoomId } from '@/lib/worker/requestGuard';

/** Max join-code length matches the Worker room-id grammar. */
export const JOIN_CODE_MAX_LENGTH = 64;

/** Client join form uses the same grammar as `isValidRoomId`. */
export function isValidJoinCode(code: string): boolean {
  return isValidRoomId(code);
}

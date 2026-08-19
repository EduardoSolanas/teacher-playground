import { describe, expect, it } from 'vitest';

/** Kick/reject return to the name prompt; suspend stays in the waiting UI. */
export function shouldClearUsernameOnEviction(flags: {
  wasKicked: boolean;
  wasRejected: boolean;
  wasSuspended: boolean;
}): boolean {
  return flags.wasKicked || flags.wasRejected;
}

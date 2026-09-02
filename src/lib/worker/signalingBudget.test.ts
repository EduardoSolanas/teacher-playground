import { describe, it, expect } from 'vitest';
import { decideSignalingAction, SIGNALING_BUDGET, SIGNALING_ABUSE_CEILING } from './signalingBudget';

describe('signalingBudget', () => {
  it('defines budget at 120 and abuse ceiling at 360', () => {
    expect(SIGNALING_BUDGET).toBe(120);
    expect(SIGNALING_ABUSE_CEILING).toBe(360);
  });

  describe('decideSignalingAction', () => {
    it('returns relay when within budget regardless of message type', () => {
      expect(decideSignalingAction({ messagesInWindow: 0, messageType: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: 1, messageType: 1 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET, messageType: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET, messageType: 1 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET, messageType: null })).toBe('relay');
    });

    it('returns relay for sync frame (messageType: 0) over budget (never drop sync)', () => {
      expect(decideSignalingAction({ messagesInWindow: 125, messageType: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: 200, messageType: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING - 1, messageType: 0 })).toBe('relay');
    });

    it('returns drop for awareness frame (messageType: 1) over budget', () => {
      expect(decideSignalingAction({ messagesInWindow: 125, messageType: 1 })).toBe('drop');
      expect(decideSignalingAction({ messagesInWindow: 200, messageType: 1 })).toBe('drop');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING - 1, messageType: 1 })).toBe('drop');
    });

    it('returns relay for non-awareness frame over budget but under ceiling', () => {
      expect(decideSignalingAction({ messagesInWindow: 125, messageType: 101 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: 125, messageType: null })).toBe('relay');
    });

    it('does NOT close on a single window over ceiling (consecutiveCeilingBreaches: 1 or default)', () => {
      // For sync frame: still relay
      expect(decideSignalingAction({ messagesInWindow: 361, messageType: 0, consecutiveCeilingBreaches: 1 })).toBe('relay');
      // For awareness frame: drop
      expect(decideSignalingAction({ messagesInWindow: 361, messageType: 1, consecutiveCeilingBreaches: 1 })).toBe('drop');
      // When consecutiveCeilingBreaches is undefined, defaults to 1 (does not close)
      expect(decideSignalingAction({ messagesInWindow: 361, messageType: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: 361, messageType: 1 })).toBe('drop');
    });

    it('closes on sustained abuse (consecutiveCeilingBreaches >= 2 and messagesInWindow >= ceiling)', () => {
      expect(decideSignalingAction({ messagesInWindow: 360, messageType: 0, consecutiveCeilingBreaches: 2 })).toBe('close');
      expect(decideSignalingAction({ messagesInWindow: 361, messageType: 1, consecutiveCeilingBreaches: 2 })).toBe('close');
      expect(decideSignalingAction({ messagesInWindow: 500, messageType: 0, consecutiveCeilingBreaches: 3 })).toBe('close');
    });
  });
});


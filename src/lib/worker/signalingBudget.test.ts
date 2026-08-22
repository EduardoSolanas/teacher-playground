import { describe, it, expect } from 'vitest';
import { decideSignalingAction, SIGNALING_BUDGET, SIGNALING_ABUSE_CEILING } from './signalingBudget';

describe('signalingBudget', () => {
  describe('decideSignalingAction', () => {
    it('returns relay at the budget', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET })).toBe('relay');
    });

    it('returns drop at budget + 1', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET + 1 })).toBe('drop');
    });

    it('returns drop at ceiling - 1', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING - 1 })).toBe('drop');
    });

    it('returns close at the ceiling', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING })).toBe('close');
    });

    it('returns relay under the budget', () => {
      expect(decideSignalingAction({ messagesInWindow: 0 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: 1 })).toBe('relay');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET - 1 })).toBe('relay');
    });

    it('returns drop in the drop zone', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_BUDGET + 2 })).toBe('drop');
      expect(decideSignalingAction({ messagesInWindow: Math.floor((SIGNALING_BUDGET + SIGNALING_ABUSE_CEILING) / 2) })).toBe('drop');
    });

    it('returns close above the ceiling', () => {
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING + 1 })).toBe('close');
      expect(decideSignalingAction({ messagesInWindow: SIGNALING_ABUSE_CEILING * 2 })).toBe('close');
    });
  });
});

import { describe, expect, it } from 'vitest';

import { CURSOR_PUBLISH_INTERVAL_MS } from './cursorPublishRate';
import { POLL_BASE_MS, PRESENCE_POLL_MAX_MS } from './pollBackoff';
import { ACTIVE_WINDOW_MS } from './presence';
import { STROKE_COMMIT_INTERVAL_MS } from './strokeCadence';
import { PRESENCE_POST_RATE_MAX, RATE_WINDOW_MS } from '../worker/rateLimits';
import { SIGNALING_BUDGET } from '../worker/signalingBudget';

describe('numeric invariants', () => {
  /**
   * Invariant 1:
   * The combined rate of cursor awareness broadcasts and stroke commits from a
   * single drawing client must fit comfortably within the signaling rate budget
   * with at least 20% headroom.
   *
   * As documented in `cursorPublishRate.ts`, `strokeCadence.ts`, and `signalingBudget.ts`:
   * - Max cursor publish rate = 1000 / CURSOR_PUBLISH_INTERVAL_MS (50ms -> 20/s)
   * - Max stroke commit rate = 1000 / STROKE_COMMIT_INTERVAL_MS (50ms -> 20/s)
   * - Combined steady-state traffic = 40 messages/sec
   * - SIGNALING_BUDGET = 120 messages/sec
   */
  it('invariant 1: cursor publish rate plus stroke commit rate fits inside signaling budget with headroom', () => {
    const maxCursorPublishRate = 1000 / CURSOR_PUBLISH_INTERVAL_MS;
    const strokeCommitRate = 1000 / STROKE_COMMIT_INTERVAL_MS;
    const combinedRate = maxCursorPublishRate + strokeCommitRate;

    expect(combinedRate).toBeLessThan(SIGNALING_BUDGET);

    // Documented requirement: at least 20% headroom (combined rate <= 80% of budget)
    const headroomRatio = (SIGNALING_BUDGET - combinedRate) / SIGNALING_BUDGET;
    expect(headroomRatio).toBeGreaterThanOrEqual(0.2);
    expect(combinedRate).toBeLessThanOrEqual(SIGNALING_BUDGET * 0.8);
  });

  /**
   * Invariant 2:
   * PRESENCE_POLL_MAX_MS * 2 <= ACTIVE_WINDOW_MS
   *
   * As documented in `pollBackoff.ts` and `presence.ts`:
   * A peer whose `last_seen` falls outside `ACTIVE_WINDOW_MS` is swept out of the
   * roster. The presence heartbeat poll backoff cannot exceed half the active window,
   * leaving room for one lost request before a present peer is treated as gone.
   */
  it('invariant 2: PRESENCE_POLL_MAX_MS * 2 <= ACTIVE_WINDOW_MS', () => {
    expect(PRESENCE_POLL_MAX_MS * 2).toBeLessThanOrEqual(ACTIVE_WINDOW_MS);
  });

  /**
   * Invariant 3:
   * PRESENCE_POST_RATE_MAX must exceed the client's actual maximum heartbeat rate with margin.
   *
   * As documented in `rateLimits.ts` and `pollBackoff.ts`:
   * - The client heartbeats presence every POLL_BASE_MS (2000ms), which is 30 POSTs/min.
   * - Setting the cap exactly at 30 caused 429s on retries / dual-tabs.
   * - PRESENCE_POST_RATE_MAX must provide a safety margin (at least 45, i.e. 1.5x of base rate).
   */
  it('invariant 3: PRESENCE_POST_RATE_MAX exceeds client maximum heartbeat rate with margin', () => {
    const clientMaxHeartbeatRatePerMinute = RATE_WINDOW_MS / POLL_BASE_MS;
    expect(clientMaxHeartbeatRatePerMinute).toBe(30);

    // Cap must exceed client rate with safety margin (at least 45 POSTs/min)
    expect(PRESENCE_POST_RATE_MAX).toBeGreaterThan(clientMaxHeartbeatRatePerMinute);
    expect(PRESENCE_POST_RATE_MAX).toBeGreaterThanOrEqual(45);
    expect(PRESENCE_POST_RATE_MAX).toBeGreaterThanOrEqual(clientMaxHeartbeatRatePerMinute * 1.5);
  });
});

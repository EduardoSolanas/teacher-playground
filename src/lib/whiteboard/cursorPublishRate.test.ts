import { describe, expect, it } from 'vitest';

import { CURSOR_PUBLISH_INTERVAL_MS, cursorPublishDelay } from './cursorPublishRate';

describe('cursorPublishDelay', () => {
  it('publishes the first cursor immediately', () => {
    expect(cursorPublishDelay(null, 1_000)).toBe(0);
  });

  it('publishes immediately once the interval has elapsed', () => {
    expect(cursorPublishDelay(1_000, 1_000 + CURSOR_PUBLISH_INTERVAL_MS)).toBe(0);
    expect(cursorPublishDelay(1_000, 5_000)).toBe(0);
  });

  it('defers a publish that would land inside the interval', () => {
    expect(cursorPublishDelay(1_000, 1_010)).toBe(CURSOR_PUBLISH_INTERVAL_MS - 10);
    expect(cursorPublishDelay(1_000, 1_049)).toBe(1);
  });

  it('stays under the Worker signaling cap of 60 messages per second', () => {
    // The Worker closes the socket with 1008 above 60 messages/sec, which is
    // what turned a moving mouse into a reconnect loop.
    expect(1_000 / CURSOR_PUBLISH_INTERVAL_MS).toBeLessThan(60);
  });

  it('never returns a negative delay for clocks that jump backwards', () => {
    expect(cursorPublishDelay(5_000, 1_000)).toBe(CURSOR_PUBLISH_INTERVAL_MS);
  });
});

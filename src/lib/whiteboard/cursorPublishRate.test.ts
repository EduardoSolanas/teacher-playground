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

describe('sustained pointer movement stays under the signaling cap', () => {
  // The Worker closes a socket that exceeds 60 messages/sec, and a moving
  // pointer used to do exactly that: the socket dropped and the peer sat in a
  // reconnect loop showing "Connecting to room…". This is that ceiling as an
  // arithmetic property rather than a duration measurement.
  function publishesIn(durationMs: number, sampleEveryMs: number): number {
    let published = 0;
    let lastPublishedAt: number | null = null;
    for (let now = 0; now <= durationMs; now += sampleEveryMs) {
      if (cursorPublishDelay(lastPublishedAt, now) === 0) {
        published += 1;
        lastPublishedAt = now;
      }
    }
    return published;
  }

  it('caps a 120Hz pointer at the publish interval, not the sample rate', () => {
    const samples = 1000 / 8;
    const published = publishesIn(1000, 8);

    expect(samples).toBeGreaterThan(60);
    expect(published).toBeLessThanOrEqual(1000 / CURSOR_PUBLISH_INTERVAL_MS + 1);
  });

  it('holds the ceiling however fast the pointer is sampled', () => {
    for (const sampleEveryMs of [1, 4, 8, 16]) {
      expect(publishesIn(1000, sampleEveryMs)).toBeLessThanOrEqual(21);
    }
  });

  it('a slow pointer is never delayed by the throttle', () => {
    expect(publishesIn(1000, 200)).toBe(6);
  });
});

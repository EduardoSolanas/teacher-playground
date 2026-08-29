import { afterEach, describe, expect, it } from 'vitest';

import {
  clearWhiteboardLatencyEvents,
  isWhiteboardLatencyProbeEnabled,
  readWhiteboardLatencyEvents,
  recordWhiteboardLatencyEvent,
} from './latencyProbe';

describe('whiteboard latency probe', () => {
  const testEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = testEnv.NODE_ENV;
  const originalE2eFlag = testEnv.NEXT_PUBLIC_E2E;
  const originalEvents = (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
    .__whiteboardLatencyEvents;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete testEnv.NODE_ENV;
    else testEnv.NODE_ENV = originalNodeEnv;
    if (originalE2eFlag === undefined) delete testEnv.NEXT_PUBLIC_E2E;
    else testEnv.NEXT_PUBLIC_E2E = originalE2eFlag;
    if (originalEvents === undefined) {
      delete (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
        .__whiteboardLatencyEvents;
    } else {
      (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
        .__whiteboardLatencyEvents = originalEvents;
    }
  });

  it('records browser events with a supplied timestamp and reads a defensive copy', () => {
    testEnv.NODE_ENV = 'development';
    delete testEnv.NEXT_PUBLIC_E2E;
    clearWhiteboardLatencyEvents();

    recordWhiteboardLatencyEvent(
      { kind: 'stroke-publish', elementId: 'element-1', version: 4, peerId: 'peer-1', x: 12, y: 24 },
      1234,
    );

    const events = readWhiteboardLatencyEvents();
    expect(events).toEqual([
      {
        kind: 'stroke-publish',
        at: 1234,
        elementId: 'element-1',
        version: 4,
        peerId: 'peer-1',
        x: 12,
        y: 24,
      },
    ]);
    events[0].at = 9999;
    expect(readWhiteboardLatencyEvents()[0].at).toBe(1234);
  });

  it('keeps only the newest 1000 events', () => {
    testEnv.NODE_ENV = 'development';
    delete testEnv.NEXT_PUBLIC_E2E;
    clearWhiteboardLatencyEvents();

    for (let index = 0; index < 1001; index += 1) {
      recordWhiteboardLatencyEvent({ kind: 'cursor-render', x: index, y: index }, index);
    }

    const events = readWhiteboardLatencyEvents();
    expect(events).toHaveLength(1000);
    expect(events[0].x).toBe(1);
    expect(events.at(-1)?.x).toBe(1000);
  });

  it('does not expose events in a production build unless E2E is enabled', () => {
    testEnv.NODE_ENV = 'production';
    testEnv.NEXT_PUBLIC_E2E = '';
    delete (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
      .__whiteboardLatencyEvents;
    clearWhiteboardLatencyEvents();

    recordWhiteboardLatencyEvent({ kind: 'cursor-publish' }, 42);

    expect(readWhiteboardLatencyEvents()).toEqual([]);
    expect((globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
      .__whiteboardLatencyEvents).toBeUndefined();
  });

  it('reports whether the debug latency probe is enabled', () => {
    testEnv.NODE_ENV = 'production';
    testEnv.NEXT_PUBLIC_E2E = '';
    expect(isWhiteboardLatencyProbeEnabled()).toBe(false);

    testEnv.NEXT_PUBLIC_E2E = '1';
    expect(isWhiteboardLatencyProbeEnabled()).toBe(true);

    testEnv.NODE_ENV = 'development';
    delete testEnv.NEXT_PUBLIC_E2E;
    expect(isWhiteboardLatencyProbeEnabled()).toBe(true);
  });


  it('allows the E2E flag in production', () => {
    testEnv.NODE_ENV = 'production';
    testEnv.NEXT_PUBLIC_E2E = '1';
    clearWhiteboardLatencyEvents();

    recordWhiteboardLatencyEvent({ kind: 'stroke-render' }, 7);

    expect(readWhiteboardLatencyEvents()[0]).toEqual({ kind: 'stroke-render', at: 7 });
  });

  it('clears recorded events', () => {
    testEnv.NODE_ENV = 'development';
    delete testEnv.NEXT_PUBLIC_E2E;
    recordWhiteboardLatencyEvent({ kind: 'stroke-render' }, 1);

    clearWhiteboardLatencyEvents();

    expect(readWhiteboardLatencyEvents()).toEqual([]);
  });
});

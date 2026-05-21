import { describe, it, expect, vi, beforeEach } from 'vitest';

const onMock = vi.fn();
const offMock = vi.fn();
const destroyMock = vi.fn();

const mockProviderInstance = {
  on: onMock,
  off: offMock,
  destroy: destroyMock,
};

function MockWebrtcProvider(_roomName: any, _doc: any, _opts: any) {
  return mockProviderInstance;
}

vi.mock('y-webrtc', () => ({
  WebrtcProvider: MockWebrtcProvider,
}));

import * as Y from 'yjs';
import { createYWebRTCProvider, destroyProvider } from './ywebrtcProvider';

describe('ywebrtcProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onMock.mockReset();
    destroyMock.mockReset();
  });

  it('initializes provider', () => {
    const doc = new Y.Doc();
    const { provider, status } = createYWebRTCProvider(doc, 'test-provider-init');

    expect(provider).toBe(mockProviderInstance);
    expect(status).toBeDefined();
    expect(typeof status).toBe('string');
    expect(onMock).toHaveBeenCalled();

    provider.destroy();
    doc.destroy();
  });

  it('handles synced event', () => {
    const doc = new Y.Doc();
    const { provider } = createYWebRTCProvider(doc, 'test-provider-synced');

    const syncedCalls = onMock.mock.calls.filter((call) => call[0] === 'synced');
    expect(syncedCalls.length).toBeGreaterThan(0);

    // Invoke the synced callback directly
    const syncedCb = syncedCalls[0][1] as () => void;
    syncedCb();

    provider.destroy();
    doc.destroy();
  });

  it('handles status events', () => {
    const doc = new Y.Doc();
    const { provider } = createYWebRTCProvider(doc, 'test-provider-status');

    const statusCalls = onMock.mock.calls.filter((call) => call[0] === 'status');
    expect(statusCalls.length).toBeGreaterThan(0);

    // Invoke the status callback directly
    const statusCb = statusCalls[0][1] as (e: { connected: boolean }) => void;
    statusCb({ connected: true });

    provider.destroy();
    doc.destroy();
  });

  it('destroys provider', () => {
    const doc = new Y.Doc();
    const { provider } = createYWebRTCProvider(doc, 'test-provider-destroy');

    expect(() => provider.destroy()).not.toThrow();
    expect(() => doc.destroy()).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { ConnectionState } from 'livekit-client';
import { LiveKitProvider } from './livekitProvider';
import { createAvSession } from './avSession';

describe('LiveKitProvider and AvSession teardown with real Room', () => {
  it('sets room state to disconnected when disconnect() is called on provider', () => {
    const provider = new LiveKitProvider();
    const room = provider.getRoom();

    provider.disconnect();

    expect(room.state).toBe(ConnectionState.Disconnected);
  });

  it('sets room state to disconnected when leave() is called on AvSession', () => {
    const provider = new LiveKitProvider();
    const room = provider.getRoom();
    const session = createAvSession(provider);

    session.leave();

    expect(room.state).toBe(ConnectionState.Disconnected);
    expect(session.getSnapshot().status).toBe('idle');
  });
});

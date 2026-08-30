import { describe, expect, it, vi } from 'vitest';

import {
  createAvSession,
  mapProviderError,
  type AvProvider,
  type AvProviderEvents,
  type ParticipantState,
} from './avSession';

interface FakeAvProvider extends AvProvider {
  calls: {
    connect: string[];
    disconnect: number;
    setMicrophone: boolean[];
    setCamera: boolean[];
    selectDevice: string[];
    requestMute: string[];
    attachTrack: string[];
    detachTrack: string[];
  };
  connectError: Error | null;
  cameraDenied: boolean;
  emit: AvProviderEvents;
}

function makeProvider(): FakeAvProvider {
  let events: AvProviderEvents = {};
  const calls = {
    connect: [] as string[],
    disconnect: 0,
    setMicrophone: [] as boolean[],
    setCamera: [] as boolean[],
    selectDevice: [] as string[],
    requestMute: [] as string[],
    attachTrack: [] as string[],
    detachTrack: [] as string[],
  };
  const provider: FakeAvProvider = {
    calls,
    connectError: null,
    cameraDenied: false,
    emit: {},
    async connect(token, url) {
      calls.connect.push(`${token}@${url}`);
      if (provider.connectError) throw provider.connectError;
      // The real provider publishes both devices as part of connecting and
      // then says what it actually got. A fake that stays silent would let the
      // session's own guess about the camera pass for the truth.
      events.onLocalMic?.(false);
      events.onLocalCamera?.(!provider.cameraDenied);
    },
    disconnect() {
      calls.disconnect += 1;
    },
    setMicrophone(muted) {
      calls.setMicrophone.push(muted);
      events.onLocalMic?.(muted);
    },
    setCamera(on) {
      calls.setCamera.push(on);
      events.onLocalCamera?.(on);
    },
    async selectDevice(kind, deviceId) {
      calls.selectDevice.push(`${kind}:${deviceId}`);
      events.onDevices?.(kind, [{ deviceId, label: `${kind} ${deviceId}` }]);
    },
    requestMute(target) {
      calls.requestMute.push(target);
    },
    attachTrack(identity, kind, element) {
      calls.attachTrack.push(`${identity}:${kind}:${element.tagName}`);
    },
    detachTrack(identity, kind, element) {
      calls.detachTrack.push(`${identity}:${kind}:${element.tagName}`);
    },
    onEvents(next) {
      events = next;
      provider.emit = next;
    },
  };
  return provider;
}

function addParticipant(provider: FakeAvProvider, participant: ParticipantState): void {
  provider.emit.onParticipant?.(participant);
}

describe('createAvSession', () => {
  it('starts idle with no participants', () => {
    const session = createAvSession(makeProvider());
    expect(session.status).toBe('idle');
    expect(session.participants).toEqual([]);
    expect(session.isActive).toBe(false);
  });

  it('joins: idle -> connecting -> joined', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    expect(session.status).toBe('idle');
    const joinPromise = session.join('token', 'wss://livekit');
    expect(session.status).toBe('connecting');
    await joinPromise;
    expect(session.status).toBe('joined');
    expect(session.isActive).toBe(true);
    expect(provider.calls.connect).toEqual(['token@wss://livekit']);
  });

  it('join is a no-op while connecting or joined', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('t1', 'url1');
    await session.join('t2', 'url2');
    expect(provider.calls.connect).toHaveLength(1);
  });

  it('maps a connect error into an error status', async () => {
    const provider = makeProvider();
    provider.connectError = new Error('Could not connect to server');
    const session = createAvSession(provider);
    await session.join('token', 'url');
    expect(session.status).toBe('error');
    expect(session.error?.kind).toBe('network');
  });

  it('leave tears down and resets to idle', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    addParticipant(provider, { identity: 'peer-1', micMuted: false, camOn: true });
    expect(session.participants.length).toBeGreaterThan(0);
    session.leave();
    expect(session.status).toBe('idle');
    expect(session.participants).toEqual([]);
    expect(provider.calls.disconnect).toBe(1);
  });

  it('tracks remote participants and removals', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    addParticipant(provider, { identity: 'peer-1', micMuted: true, camOn: false });
    expect(session.participants).toEqual([{ identity: 'peer-1', micMuted: true, camOn: false }]);
    addParticipant(provider, { identity: 'peer-2', micMuted: false, camOn: true });
    expect(session.participants).toHaveLength(2);
    provider.emit.onParticipantRemoved?.('peer-1');
    expect(session.participants.map((p) => p.identity)).toEqual(['peer-2']);
  });

  it('toggleMicrophone flips local state and calls the provider', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    expect(session.local.micMuted).toBe(false);
    session.toggleMicrophone();
    expect(session.local.micMuted).toBe(true);
    expect(provider.calls.setMicrophone).toEqual([true]);
    session.toggleMicrophone();
    expect(provider.calls.setMicrophone).toEqual([true, false]);
  });

  it('toggleCamera flips local state and calls the provider', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    expect(session.local.camOn).toBe(true);
    session.toggleCamera();
    expect(session.local.camOn).toBe(false);
    expect(provider.calls.setCamera).toEqual([false]);
  });

  it('selectDevice records device ids and forwards to the provider', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    await session.selectDevice('microphone', 'dev-1');
    await session.selectDevice('camera', 'cam-1');
    expect(provider.calls.selectDevice).toEqual(['microphone:dev-1', 'camera:cam-1']);
    expect(session.devices.microphone.map((d) => d.deviceId)).toContain('dev-1');
    expect(session.devices.camera.map((d) => d.deviceId)).toContain('cam-1');
  });

  it('disconnected event returns to idle and clears participants', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    addParticipant(provider, { identity: 'peer-1', micMuted: false, camOn: true });
    provider.emit.onDisconnected?.();
    expect(session.status).toBe('idle');
    expect(session.participants).toEqual([]);
  });

  it('provider error event moves to error status', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    provider.emit.onError?.({ kind: 'permission-denied', message: 'denied' });
    expect(session.status).toBe('error');
    expect(session.error?.kind).toBe('permission-denied');
  });

  it('requestMute forwards only when joined', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    session.requestMute('peer-1');
    expect(provider.calls.requestMute).toEqual([]);
    await session.join('token', 'url');
    session.requestMute('peer-1');
    expect(provider.calls.requestMute).toEqual(['peer-1']);
  });

  it('does not claim the camera is on before the call is up', async () => {
    // The panel reads this to label its button. Guessing the camera is already
    // on makes the button read "Camera on" while it would in fact turn it off.
    const provider = makeProvider();
    const session = createAvSession(provider);
    expect(session.local.camOn).toBe(false);
    provider.cameraDenied = true;
    await session.join('token', 'url');
    expect(session.local.camOn).toBe(false);
  });

  it('refuses a toggle until the call is up', async () => {
    // Connecting publishes both devices itself, so anything pressed while that
    // is in flight is overwritten a moment later. Better to refuse it than to
    // take it and lose it.
    const provider = makeProvider();
    const session = createAvSession(provider);
    const joining = session.join('token', 'url');
    session.toggleMicrophone();
    session.toggleCamera();
    expect(provider.calls.setMicrophone).toEqual([]);
    expect(provider.calls.setCamera).toEqual([]);
    await joining;
    session.toggleMicrophone();
    expect(provider.calls.setMicrophone).toEqual([true]);
  });

  it('keeps the call when a device fails mid-lesson', async () => {
    // A refused camera is not a call that has ended. Reporting it as one takes
    // the mic button away too, and the mic was working.
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    provider.emit.onError?.({ kind: 'permission-denied', message: 'camera denied' });
    expect(session.status).toBe('joined');
    expect(session.error?.message).toBe('camera denied');
    session.toggleMicrophone();
    expect(provider.calls.setMicrophone).toEqual([true]);
  });

  it('attachTrack and detachTrack forward to the provider', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    const el = { tagName: 'AUDIO' } as HTMLMediaElement;
    session.attachTrack('peer-1', 'microphone', el);
    session.detachTrack('peer-1', 'microphone', el);
    expect(provider.calls.attachTrack).toEqual(['peer-1:microphone:AUDIO']);
    expect(provider.calls.detachTrack).toEqual(['peer-1:microphone:AUDIO']);
  });
});

describe('mapProviderError', () => {
  it('classifies permission denials', () => {
    expect(mapProviderError(new Error('Permission denied')).kind).toBe('permission-denied');
  });
  it('classifies device errors', () => {
    expect(mapProviderError(new Error('No device found')).kind).toBe('device-missing');
  });
  it('classifies configuration errors', () => {
    expect(mapProviderError(new Error('LiveKit is not configured')).kind).toBe('not-configured');
  });
  it('classifies network errors', () => {
    expect(mapProviderError(new Error('connect timeout')).kind).toBe('network');
  });
  it('defaults unknown errors to unknown', () => {
    expect(mapProviderError(new Error('something else entirely')).kind).toBe('unknown');
  });
});

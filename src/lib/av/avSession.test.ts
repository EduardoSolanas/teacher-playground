import { describe, expect, it, vi } from 'vitest';

import {
  createAvSession,
  mapProviderError,
  type AvProvider,
  type AvProviderEvents,
  type AvSessionListener,
  type ParticipantState,
} from './avSession';

interface FakeAvProvider extends AvProvider {
  calls: {
    connect: string[];
    disconnect: number;
    setMicrophone: boolean[];
    setCamera: boolean[];
    selectDevice: string[];
    attachTrack: string[];
    detachTrack: string[];
  };
  connectError: Error | null;
  selectDeviceError: Error | null;
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
    attachTrack: [] as string[],
    detachTrack: [] as string[],
  };
  const provider: FakeAvProvider = {
    calls,
    connectError: null,
    selectDeviceError: null,
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
      if (provider.selectDeviceError) throw provider.selectDeviceError;
      events.onDevices?.(kind, [{ deviceId, label: `${kind} ${deviceId}` }]);
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
    addParticipant(provider, { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false });
    expect(session.participants.length).toBeGreaterThan(0);
    session.leave();
    expect(session.status).toBe('idle');
    expect(session.participants).toEqual([]);
    expect(provider.calls.disconnect).toBe(1);
  });

  it('tracks remote participants and removals', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    addParticipant(provider, { identity: 'peer-1', micMuted: true, micPresent: true, camOn: false, isSpeaking: false });
    expect(session.participants).toEqual([{ identity: 'peer-1', micMuted: true, micPresent: true, camOn: false, isSpeaking: false }]);
    addParticipant(provider, { identity: 'peer-2', micMuted: false, micPresent: true, camOn: true, isSpeaking: true });
    expect(session.participants).toHaveLength(2);
    provider.emit.onParticipantRemoved?.('peer-1');
    expect(session.participants.map((p) => p.identity)).toEqual(['peer-2']);
  });

  it('notifies listeners when provider events change session state', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    const listener = vi.fn<AvSessionListener>();
    const unsubscribe = session.subscribe(listener);

    await session.join('token', 'url');
    listener.mockClear();

    addParticipant(provider, { identity: 'peer-1', micMuted: true, micPresent: true, camOn: false, isSpeaking: false });
    expect(listener).toHaveBeenCalledTimes(1);

    provider.emit.onLocalMic?.(true);
    expect(listener).toHaveBeenCalledTimes(2);

    provider.emit.onParticipantRemoved?.('peer-1');
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    provider.emit.onLocalCamera?.(true);
    expect(listener).toHaveBeenCalledTimes(3);
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
    addParticipant(provider, { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false });
    provider.emit.onDisconnected?.();
    expect(session.status).toBe('idle');
    expect(session.participants).toEqual([]);
  });

  it('reconnecting keeps the call and every face in it', async () => {
    // LiveKit re-connects a dropped socket on its own. Reporting that drop
    // through onDisconnected's full reset emptied the panel of faces that were
    // in fact still there, while the socket quietly re-established itself.
    // Say reconnecting instead, and keep everything until the socket is back.
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    addParticipant(provider, { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false });

    provider.emit.onReconnecting?.();

    expect(session.status).toBe('reconnecting');
    expect(session.participants.map((p) => p.identity)).toEqual(['__local__', 'peer-1']);
    expect(session.local.micMuted).toBe(false);
    expect(session.local.camOn).toBe(true);
  });

  it('reconnected returns to joined with the room intact', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    addParticipant(provider, { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false });
    provider.emit.onReconnecting?.();

    provider.emit.onReconnected?.();

    expect(session.status).toBe('joined');
    expect(session.participants.map((p) => p.identity)).toEqual(['__local__', 'peer-1']);
  });

  it('carries the local connection quality onto the local participant', async () => {
    // The remote faces have carried their quality badge all along; the person
    // whose uplink the lesson actually depends on was hardcoded to 'unknown'.
    // The tile renders participant.quality for whoever it shows, so the local
    // entry needs the same truth the remote ones get.
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');

    provider.emit.onLocalQuality?.('poor');

    const local = session.participants.find((p) => p.identity === '__local__');
    expect(local?.quality).toBe('poor');
  });
  it('provider error event moves to error status', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    provider.emit.onError?.({ kind: 'permission-denied', message: 'denied' });
    expect(session.status).toBe('error');
    expect(session.error?.kind).toBe('permission-denied');
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

  it('a mute pressed during reconnection still reaches the provider', async () => {
    // The refusal above is about connecting, where the join publishes both
    // devices and would overwrite whatever was asked for. Reconnection is
    // different: the tracks already exist and stay mine. Refusing the toggle
    // mid-drop takes the working mic away from the teacher precisely when the
    // lesson is struggling to hold together.
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    provider.emit.onReconnecting?.();

    session.toggleMicrophone();

    expect(provider.calls.setMicrophone).toEqual([true]);
    expect(session.local.micMuted).toBe(true);
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

  it('keeps the call joined when a device switch is refused', async () => {
    // Switching to a laptop dock's camera and having the browser refuse it is
    // not the call ending. It used to set status='error', which disabled the
    // mic and the camera and left the whole panel saying the call had failed
    // over a camera that was simply not there.
    const provider = makeProvider();
    provider.selectDeviceError = Object.assign(new Error('Could not start video source'), {
      name: 'NotReadableError',
    });
    const session = createAvSession(provider);
    await session.join('token', 'url');

    await session.selectDevice('camera', 'cam-2');

    expect(session.status).toBe('joined');
    expect(session.error?.kind).toBe('device-busy');
  });

  it('clears a transient error after a later successful action', async () => {
    // A one-off glitch used to leave the banner up for the rest of the lesson,
    // with no way to dismiss it and no later success able to take it down.
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    provider.emit.onError?.({ kind: 'unknown', message: 'temporary glitch' });
    expect(session.error).not.toBeNull();

    session.toggleMicrophone();

    expect(session.error).toBeNull();
  });

  it('clears a transient error after the socket comes back', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');
    provider.emit.onReconnecting?.();
    provider.emit.onError?.({ kind: 'network', message: 'socket hiccup' });
    expect(session.error).not.toBeNull();

    provider.emit.onReconnected?.();

    expect(session.status).toBe('joined');
    expect(session.error).toBeNull();
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

  it('defaults the local fallback participant to not speaking and updates speaking changes', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);

    await session.join('token', 'url');

    expect(session.participants).toContainEqual({
      identity: '__local__',
      micMuted: false,
      micPresent: true,
      camOn: true,
      isSpeaking: false,
      quality: 'unknown',
    });

    addParticipant(provider, {
      identity: 'peer-1',
      micMuted: false,
      micPresent: true,
      camOn: true,
      isSpeaking: true,
    });

    expect(session.participants).toContainEqual({
      identity: 'peer-1',
      micMuted: false,
      micPresent: true,
      camOn: true,
      isSpeaking: true,
    });
  });

  it('exposes the active device from the provider', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);

    // Initially no active device
    expect(session.activeDevices.microphone).toBeUndefined();
    expect(session.activeDevices.camera).toBeUndefined();
    expect(session.activeDevices.speaker).toBeUndefined();

    // Provider reports active device
    provider.emit.onActiveDevice?.('microphone', 'mic-device-123');
    expect(session.activeDevices.microphone).toBe('mic-device-123');

    provider.emit.onActiveDevice?.('camera', 'cam-device-456');
    expect(session.activeDevices.camera).toBe('cam-device-456');

    provider.emit.onActiveDevice?.('speaker', 'spk-device-789');
    expect(session.activeDevices.speaker).toBe('spk-device-789');
  });

  it('notifies listeners when active device changes', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    const listener = vi.fn<AvSessionListener>();
    session.subscribe(listener);

    provider.emit.onActiveDevice?.('microphone', 'mic-device-123');
    expect(listener).toHaveBeenCalled();
  });

  it('clears active devices when leaving', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);
    await session.join('token', 'url');

    provider.emit.onActiveDevice?.('microphone', 'mic-device-123');
    expect(session.activeDevices.microphone).toBe('mic-device-123');

    session.leave();

    expect(session.activeDevices.microphone).toBeUndefined();
    expect(session.activeDevices.camera).toBeUndefined();
    expect(session.activeDevices.speaker).toBeUndefined();
  });

  it('includes activeDevices in the snapshot', async () => {
    const provider = makeProvider();
    const session = createAvSession(provider);

    provider.emit.onActiveDevice?.('microphone', 'mic-device-123');

    const snapshot = session.getSnapshot();
    expect(snapshot.activeDevices.microphone).toBe('mic-device-123');
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
  it('classifies a device held by another app as busy', () => {
    // getUserMedia says NotReadableError when a camera or mic is already in
    // use elsewhere, and AbortError when the browser gives up starting the
    // track. Both used to fall through to 'unknown', which put raw browser
    // text in the banner and told the person nothing they could act on.
    const busy = Object.assign(new Error('Could not start video source'), {
      name: 'NotReadableError',
    });
    expect(mapProviderError(busy).kind).toBe('device-busy');

    const aborted = Object.assign(new Error('Starting videoinput failed'), {
      name: 'AbortError',
    });
    expect(mapProviderError(aborted).kind).toBe('device-busy');
  });
  it('still classifies a missing device as missing, not busy', () => {
    // "The device is in use" also contains "device"; the busy check has to
    // come first or a genuine NotFoundError would be reported as busy.
    const missing = Object.assign(new Error('Requested device not found'), {
      name: 'NotFoundError',
    });
    expect(mapProviderError(missing).kind).toBe('device-missing');
  });
  it('defaults unknown errors to unknown', () => {
    expect(mapProviderError(new Error('something else entirely')).kind).toBe('unknown');
  });
});

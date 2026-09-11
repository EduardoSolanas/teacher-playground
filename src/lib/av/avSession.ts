/**
 * A/V session controller.
 *
 * This is the pure, testable core of the video feature. It drives a provider
 * adapter (the external WebRTC SFU boundary) through join/leave/mute/camera/
 * device/participant transitions and exposes a small state machine the UI can
 * render. The provider is deliberately an interface so tests use a
 * protocol-faithful fake instead of a real SFU connection.
 */

import { writeDevicePreference } from './devicePreferences';

/*
 * 'reconnecting' is the middle of a dropped-and-recovering socket: LiveKit
 * re-establishes it on its own, so the call is neither joined nor over. The
 * panel reads this to say so instead of either lying (joined) or clearing the
 * room (the old full-reset path).
 */
export type AvSessionStatus = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'error';

export type AvErrorKind =
  | 'permission-denied'
  | 'device-missing'
  | 'device-busy'
  | 'not-configured'
  | 'network'
  | 'unsupported'
  | 'unknown';

export interface AvError {
  readonly kind: AvErrorKind;
  readonly message: string;
}

export interface ParticipantState {
  readonly identity: string;
  readonly micMuted: boolean;
  readonly micPresent: boolean;
  readonly camOn: boolean;
  readonly isSpeaking: boolean;
  readonly quality?: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
}

export interface LocalState {
  micMuted: boolean;
  camOn: boolean;
  isScreenSharing: boolean;
}

export type DeviceKind = 'microphone' | 'camera' | 'speaker';

/**
 * A device, with the name its owner would recognise.
 *
 * The id alone is a forty-character hash; a menu of those is not a choice
 * anybody can make. The label is empty until the browser has a permission to
 * show it by, so whoever renders one has to have a fallback.
 */
export interface AvDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface AvProviderEvents {
  onParticipant?: (participant: ParticipantState) => void;
  onParticipantRemoved?: (identity: string) => void;
  onLocalMic?: (muted: boolean) => void;
  onLocalCamera?: (on: boolean) => void;
  onLocalScreenShare?: (on: boolean) => void;
  onLocalSpeaking?: (speaking: boolean) => void;
  /** The caller's own uplink quality, as the SDK reports it. */
  onLocalQuality?: (quality: ParticipantState['quality']) => void;
  /** The socket dropped and the SDK is re-establishing it. The call continues. */
  onReconnecting?: () => void;
  /** The socket is back; the call is fully joined again. */
  onReconnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: AvError) => void;
  onDevices?: (kind: DeviceKind, devices: AvDevice[]) => void;
  /** The active device for a given kind changed. */
  onActiveDevice?: (kind: DeviceKind, deviceId: string) => void;
}

export interface AvProvider {
  connect(token: string, url: string): Promise<void>;
  disconnect(): void;
  setMicrophone(muted: boolean): void;
  setCamera(on: boolean): void;
  toggleScreenShare?(): Promise<void>;
  selectDevice(kind: DeviceKind, deviceId: string): Promise<void>;
  onEvents(events: AvProviderEvents): void;
  attachTrack?(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void;
  detachTrack?(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void;
  getRoom?(): unknown | null;
}

export interface AvSessionSnapshot {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: Readonly<LocalState>;
  readonly participants: readonly ParticipantState[];
  readonly devices: Readonly<Record<DeviceKind, readonly AvDevice[]>>;
  readonly activeDevices: Readonly<Record<DeviceKind, string | undefined>>;
}

export type AvSessionListener = () => void;

export interface AvSession {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: LocalState;
  readonly participants: ParticipantState[];
  readonly devices: Record<DeviceKind, AvDevice[]>;
  readonly activeDevices: Record<DeviceKind, string | undefined>;
  getSnapshot(): AvSessionSnapshot;
  subscribe(listener: AvSessionListener): () => void;
  join(token: string, url: string): Promise<void>;
  leave(): void;
  toggleMicrophone(): void;
  toggleCamera(): void;
  toggleScreenShare(): Promise<void>;
  selectDevice(kind: DeviceKind, deviceId: string): Promise<void>;
  attachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void;
  detachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void;
  getRoom?(): unknown | null;
  /** True when the provider is configured and a join is in flight or joined. */
  readonly isActive: boolean;
}

export function mapProviderError(error: unknown): AvError {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  // The name carries as much as the message does: getUserMedia rejects with
  // NotReadableError/AbortError, and their messages vary between browsers --
  // the name is the stable half, so both are searched.
  const name = error instanceof Error ? error.name : '';
  const lower = `${name} ${message}`.toLowerCase();
  let kind: AvErrorKind = 'unknown';
  if (lower.includes('permission') || lower.includes('denied') || lower.includes('notallowed')) {
    kind = 'permission-denied';
  } else if (
    lower.includes('notreadable') ||
    lower.includes('aborterror') ||
    lower.includes('could not start') ||
    lower.includes('starting ') ||
    lower.includes('failed to start') ||
    lower.includes('in use')
  ) {
    /*
     * A camera or microphone another application already holds. The browser
     * refuses to share it, and the only fix is to close that other app -- so
     * this is a separate kind with its own copy rather than one more flavour
     * of 'unknown' that prints raw browser text at a teacher.
     *
     * Ahead of the device-missing branch on purpose: "the device is in use"
     * contains the word "device", and an in-use device is not a missing one.
     */
    kind = 'device-busy';
  } else if (lower.includes('device') || lower.includes('notfound') || lower.includes('overconstrained')) {
    kind = 'device-missing';
  } else if (lower.includes('config') || lower.includes('not configured')) {
    kind = 'not-configured';
  } else if (lower.includes('network') || lower.includes('timeout') || lower.includes('connect')) {
    kind = 'network';
  }
  return { kind, message };
}

export function createAvSession(provider: AvProvider): AvSession {
  let status: AvSessionStatus = 'idle';
  let error: AvError | null = null;
  // The camera is off until a join publishes it and the provider says so.
  // Seeding it on makes every label lie for as long as the join takes.
  let local: LocalState = { micMuted: false, camOn: false, isScreenSharing: false };
  let localSpeaking = false;
  /*
   * The local participant's own connection quality, unknown until the SDK
   * reports it. It rides on the '__local__' participant entry like the remote
   * quality rides on theirs, so the tile renders one badge rule for anyone.
   */
  let localQuality: ParticipantState['quality'] = 'unknown';
  const participants: ParticipantState[] = [];
  const devices: Record<DeviceKind, AvDevice[]> = { microphone: [], camera: [], speaker: [] };
  const activeDevices: Record<DeviceKind, string | undefined> = { microphone: undefined, camera: undefined, speaker: undefined };
  const listeners = new Set<AvSessionListener>();
  let snapshot: AvSessionSnapshot;

  function updateSnapshot(): void {
    snapshot = {
      status,
      error,
      local: { ...local },
      participants: [...participants],
      devices: {
        microphone: [...devices.microphone],
        camera: [...devices.camera],
        speaker: [...devices.speaker],
      },
      activeDevices: {
        microphone: activeDevices.microphone,
        camera: activeDevices.camera,
        speaker: activeDevices.speaker,
      },
    };
  }

  function emitChange(): void {
    updateSnapshot();
    listeners.forEach((listener) => listener());
  }

  updateSnapshot();

  function updateLocalParticipant(): void {
    const index = participants.findIndex((p) => p.identity === '__local__');
    const entry: ParticipantState = {
      identity: '__local__',
      micMuted: local.micMuted,
      micPresent: true,
      camOn: local.camOn,
      isSpeaking: localSpeaking,
      quality: localQuality,
    };
    if (index >= 0) participants[index] = entry;
    else participants.push(entry);
  }

  function clearParticipants(): void {
    participants.length = 0;
  }

  provider.onEvents({
    onParticipant(participant) {
      const index = participants.findIndex((p) => p.identity === participant.identity);
      if (index >= 0) participants[index] = participant;
      else participants.push(participant);
      emitChange();
    },
    onParticipantRemoved(identity) {
      const index = participants.findIndex((p) => p.identity === identity);
      if (index >= 0) participants.splice(index, 1);
      emitChange();
    },
    onLocalMic(muted) {
      local.micMuted = muted;
      updateLocalParticipant();
      emitChange();
    },
    onLocalQuality(quality) {
      localQuality = quality ?? 'unknown';
      updateLocalParticipant();
      emitChange();
    },
    onLocalCamera(on) {
      local.camOn = on;
      updateLocalParticipant();
      emitChange();
    },
    onLocalScreenShare(on) {
      local.isScreenSharing = on;
      emitChange();
    },
    onLocalSpeaking(speaking) {
      localSpeaking = speaking;
      updateLocalParticipant();
      emitChange();
    },
    /*
     * A dropped socket is not an ended call. LiveKit re-establishes it on its
     * own -- usually within seconds -- so everything on screen stays: the
     * participants, the local toggles, the devices. Only the status moves, and
     * the panel says what is happening rather than emptying the room as if
     * everybody had left.
     */
    onReconnecting() {
      if (status === 'joined') status = 'reconnecting';
      emitChange();
    },
    onReconnected() {
      if (status === 'reconnecting') status = 'joined';
      // The socket is back, so whatever the drop reported is no longer news.
      error = null;
      emitChange();
    },
    onDisconnected() {
      status = 'idle';
      clearParticipants();
      local = { micMuted: false, camOn: false, isScreenSharing: false };
      localSpeaking = false;
      localQuality = 'unknown';
      emitChange();
    },
    onError(err) {
      error = err;
      // A refused device during a live call is worth saying, but it is not the
      // call failing: leaving 'joined' would take the working half of the call
      // (the mic, when it was the camera that was refused) away as well. The
      // same reasoning covers reconnecting: the SDK is already bringing the
      // socket back, and an error mid-drop must not turn that into an ending.
      if (status !== 'joined' && status !== 'reconnecting') status = 'error';
      emitChange();
    },
    onDevices(kind, list) {
      devices[kind] = list;
      emitChange();
    },
    onActiveDevice(kind, deviceId) {
      activeDevices[kind] = deviceId;
      emitChange();
    },
  });

  async function join(token: string, url: string): Promise<void> {
    if (status === 'connecting' || status === 'joined') return;
    status = 'connecting';
    error = null;
    updateLocalParticipant();
    emitChange();
    try {
      await provider.connect(token, url);
      status = 'joined';
      emitChange();
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
      emitChange();
    }
  }

  function leave(): void {
    try {
      provider.disconnect();
    } catch {
      // best effort teardown
    }
    status = 'idle';
    error = null;
    clearParticipants();
    local = { micMuted: false, camOn: false, isScreenSharing: false };
    localSpeaking = false;
    localQuality = 'unknown';
    devices.microphone = [];
    devices.camera = [];
    devices.speaker = [];
    activeDevices.microphone = undefined;
    activeDevices.camera = undefined;
    activeDevices.speaker = undefined;
    emitChange();
  }

  /*
   * The toggles refuse everything but a live call -- except reconnection.
   * During connecting the join publishes both devices and would overwrite
   * whatever was asked for, but the tracks of a reconnecting call already
   * exist and stay the caller's own, so a mute pressed mid-drop still means
   * something.
   */
  function callAcceptsToggles(): boolean {
    return status === 'joined' || status === 'reconnecting';
  }

  function toggleMicrophone(): void {
    if (!callAcceptsToggles()) return;
    local.micMuted = !local.micMuted;
    try {
      provider.setMicrophone(local.micMuted);
      // The action went through, so a transient error from a moment ago has
      // been answered. A later async failure re-raises its own.
      error = null;
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
    }
    updateLocalParticipant();
    emitChange();
  }

  function toggleCamera(): void {
    if (!callAcceptsToggles()) return;
    local.camOn = !local.camOn;
    try {
      provider.setCamera(local.camOn);
      error = null;
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
    }
    updateLocalParticipant();
    emitChange();
  }

  async function toggleScreenShare(): Promise<void> {
    if (status !== 'joined') return;
    if (provider.toggleScreenShare) {
      try {
        await provider.toggleScreenShare();
      } catch (err) {
        error = mapProviderError(err);
        status = 'error';
      }
      emitChange();
    }
  }

  async function selectDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    if (status === 'idle') return;
    try {
      await provider.selectDevice(kind, deviceId);
      if (!devices[kind].some((device) => device.deviceId === deviceId)) {
        devices[kind].push({ deviceId, label: '' });
      }
      writeDevicePreference(kind, deviceId);
      // The switch went through; the banner was about the previous pick.
      error = null;
    } catch (err) {
      /*
       * A refused switch is not a failed call. Setting status='error' here --
       * which it used to do -- disabled the mic and camera and told everyone
       * the call had broken because the browser would not hand over one
       * device. Stay joined and say what happened to the picker instead; the
       * active device is whatever the provider still reports, so the control
       * springs back to the device that does work.
       */
      if (status !== 'joined' && status !== 'reconnecting') status = 'error';
      error = mapProviderError(err);
    }
    emitChange();
  }

  function subscribe(listener: AvSessionListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function attachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void {
    provider.attachTrack?.(identity, kind, element);
  }

  function detachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void {
    provider.detachTrack?.(identity, kind, element);
  }

  return {
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get local() {
      return local;
    },
    get participants() {
      return participants;
    },
    get devices() {
      return devices;
    },
    get activeDevices() {
      return activeDevices;
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe,
    get isActive() {
      return status === 'connecting' || status === 'joined';
    },
    join,
    leave,
    toggleMicrophone,
    toggleCamera,
    toggleScreenShare,
    selectDevice,
    attachTrack,
    detachTrack,
    getRoom: () => provider.getRoom?.() ?? null,
  };
}

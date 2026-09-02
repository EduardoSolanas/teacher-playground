/**
 * A/V session controller.
 *
 * This is the pure, testable core of the video feature. It drives a provider
 * adapter (the external WebRTC SFU boundary) through join/leave/mute/camera/
 * device/participant transitions and exposes a small state machine the UI can
 * render. The provider is deliberately an interface so tests use a
 * protocol-faithful fake instead of a real SFU connection.
 */

export type AvSessionStatus = 'idle' | 'connecting' | 'joined' | 'error';

export type AvErrorKind =
  | 'permission-denied'
  | 'device-missing'
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
}

export type DeviceKind = 'microphone' | 'camera';

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
  onLocalSpeaking?: (speaking: boolean) => void;
  onDisconnected?: () => void;
  onError?: (error: AvError) => void;
  onDevices?: (kind: DeviceKind, devices: AvDevice[]) => void;
}

export interface AvProvider {
  connect(token: string, url: string): Promise<void>;
  disconnect(): void;
  setMicrophone(muted: boolean): void;
  setCamera(on: boolean): void;
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
}

export interface AvSessionSnapshot {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: Readonly<LocalState>;
  readonly participants: readonly ParticipantState[];
  readonly devices: Readonly<Record<DeviceKind, readonly AvDevice[]>>;
}

export type AvSessionListener = () => void;

export interface AvSession {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: LocalState;
  readonly participants: ParticipantState[];
  readonly devices: Record<DeviceKind, AvDevice[]>;
  getSnapshot(): AvSessionSnapshot;
  subscribe(listener: AvSessionListener): () => void;
  join(token: string, url: string): Promise<void>;
  leave(): void;
  toggleMicrophone(): void;
  toggleCamera(): void;
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
  /** True when the provider is configured and a join is in flight or joined. */
  readonly isActive: boolean;
}

export function mapProviderError(error: unknown): AvError {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const lower = message.toLowerCase();
  let kind: AvErrorKind = 'unknown';
  if (lower.includes('permission') || lower.includes('denied')) kind = 'permission-denied';
  else if (lower.includes('device') || lower.includes('notfound') || lower.includes('overconstrained')) {
    kind = 'device-missing';
  } else if (lower.includes('config') || lower.includes('not configured')) kind = 'not-configured';
  else if (lower.includes('network') || lower.includes('timeout') || lower.includes('connect')) kind = 'network';
  return { kind, message };
}

export function createAvSession(provider: AvProvider): AvSession {
  let status: AvSessionStatus = 'idle';
  let error: AvError | null = null;
  // The camera is off until a join publishes it and the provider says so.
  // Seeding it on makes every label lie for as long as the join takes.
  let local: LocalState = { micMuted: false, camOn: false };
  let localSpeaking = false;
  const participants: ParticipantState[] = [];
  const devices: Record<DeviceKind, AvDevice[]> = { microphone: [], camera: [] };
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
      quality: 'unknown',
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
    onLocalCamera(on) {
      local.camOn = on;
      updateLocalParticipant();
      emitChange();
    },
    onLocalSpeaking(speaking) {
      localSpeaking = speaking;
      updateLocalParticipant();
      emitChange();
    },
    onDisconnected() {
      status = 'idle';
      clearParticipants();
      local = { micMuted: false, camOn: false };
      localSpeaking = false;
      emitChange();
    },
    onError(err) {
      error = err;
      // A refused device during a live call is worth saying, but it is not the
      // call failing: leaving 'joined' would take the working half of the call
      // (the mic, when it was the camera that was refused) away as well.
      if (status !== 'joined') status = 'error';
      emitChange();
    },
    onDevices(kind, list) {
      devices[kind] = list;
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
    local = { micMuted: false, camOn: false };
    localSpeaking = false;
    devices.microphone = [];
    devices.camera = [];
    emitChange();
  }

  function toggleMicrophone(): void {
    if (status !== 'joined') return;
    local.micMuted = !local.micMuted;
    try {
      provider.setMicrophone(local.micMuted);
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
    }
    updateLocalParticipant();
    emitChange();
  }

  function toggleCamera(): void {
    if (status !== 'joined') return;
    local.camOn = !local.camOn;
    try {
      provider.setCamera(local.camOn);
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
    }
    updateLocalParticipant();
    emitChange();
  }

  async function selectDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    if (status === 'idle') return;
    try {
      await provider.selectDevice(kind, deviceId);
      if (!devices[kind].some((device) => device.deviceId === deviceId)) {
        devices[kind].push({ deviceId, label: '' });
      }
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
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
    selectDevice,
    attachTrack,
    detachTrack,
  };
}

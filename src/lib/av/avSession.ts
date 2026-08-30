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
  readonly camOn: boolean;
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
  /** Host soft-mute: ask a remote peer to mute their mic (best-effort). */
  requestMute?(targetIdentity: string): void;
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

export interface AvSession {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: LocalState;
  readonly participants: ParticipantState[];
  readonly devices: Record<DeviceKind, AvDevice[]>;
  join(token: string, url: string): Promise<void>;
  leave(): void;
  toggleMicrophone(): void;
  toggleCamera(): void;
  selectDevice(kind: DeviceKind, deviceId: string): Promise<void>;
  requestMute(targetIdentity: string): void;
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
  const participants: ParticipantState[] = [];
  const devices: Record<DeviceKind, AvDevice[]> = { microphone: [], camera: [] };

  function updateLocalParticipant(): void {
    const index = participants.findIndex((p) => p.identity === '__local__');
    const entry: ParticipantState = {
      identity: '__local__',
      micMuted: local.micMuted,
      camOn: local.camOn,
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
    },
    onParticipantRemoved(identity) {
      const index = participants.findIndex((p) => p.identity === identity);
      if (index >= 0) participants.splice(index, 1);
    },
    onLocalMic(muted) {
      local.micMuted = muted;
      updateLocalParticipant();
    },
    onLocalCamera(on) {
      local.camOn = on;
      updateLocalParticipant();
    },
    onDisconnected() {
      status = 'idle';
      clearParticipants();
      local = { micMuted: false, camOn: false };
    },
    onError(err) {
      error = err;
      // A refused device during a live call is worth saying, but it is not the
      // call failing: leaving 'joined' would take the working half of the call
      // (the mic, when it was the camera that was refused) away as well.
      if (status !== 'joined') status = 'error';
    },
    onDevices(kind, list) {
      devices[kind] = list;
    },
  });

  async function join(token: string, url: string): Promise<void> {
    if (status === 'connecting' || status === 'joined') return;
    status = 'connecting';
    error = null;
    updateLocalParticipant();
    try {
      await provider.connect(token, url);
      status = 'joined';
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
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
    devices.microphone = [];
    devices.camera = [];
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
  }

  function requestMute(targetIdentity: string): void {
    if (status !== 'joined') return;
    try {
      provider.requestMute?.(targetIdentity);
    } catch (err) {
      error = mapProviderError(err);
      status = 'error';
    }
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
    get isActive() {
      return status === 'connecting' || status === 'joined';
    },
    join,
    leave,
    toggleMicrophone,
    toggleCamera,
    selectDevice,
    requestMute,
    attachTrack,
    detachTrack,
  };
}

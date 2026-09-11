/**
 * LiveKit provider adapter (browser client).
 *
 * Maps the `livekit-client` API onto the `AvProvider` seam used by the A/V
 * session state machine. Join/leave/mute transitions are orchestrated by
 * `avSession.ts` (unit-tested against a fake). Connecting this adapter to a
 * real LiveKit server requires a configured project (see README).
 *
 * Connect publishes microphone + camera. Permission denial for either device is
 * isolated so a denied camera still allows voice (tile shows "Camera off").
 */

import {
  ConnectionQuality,
  ParticipantEvent,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client';

import type {
  AvProvider,
  AvProviderEvents,
  DeviceKind,
  ParticipantState,
} from './avSession';
import { mapProviderError } from './avSession';
import { readDevicePreference } from './devicePreferences';

function mapConnectionQuality(
  quality: ConnectionQuality | undefined,
): 'excellent' | 'good' | 'poor' | 'lost' | 'unknown' {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'excellent';
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
      return 'poor';
    case ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
}

function participantState(participant: Participant): ParticipantState {
  return {
    identity: participant.identity,
    micMuted: !participant.isMicrophoneEnabled,
    micPresent: participant.getTrackPublication(Track.Source.Microphone) !== undefined,
    camOn: participant.isCameraEnabled,
    isSpeaking: participant.isSpeaking,
    quality: mapConnectionQuality(participant.connectionQuality),
  };
}

function mediaKind(kind: DeviceKind): MediaDeviceKind {
  if (kind === 'speaker') return 'audiooutput';
  return kind === 'microphone' ? 'audioinput' : 'videoinput';
}

function deviceKind(media: MediaDeviceKind): DeviceKind | undefined {
  if (media === 'audioinput') return 'microphone';
  if (media === 'videoinput') return 'camera';
  if (media === 'audiooutput') return 'speaker';
  return undefined;
}

export class LiveKitProvider implements AvProvider {
  private readonly room: Room;
  private events: AvProviderEvents = {};
  private wired = false;
  private activeSpeakerIds = new Set<string>();

  constructor() {
    const micPref = readDevicePreference('microphone');
    const camPref = readDevicePreference('camera');

    this.room = new Room({
      ...(micPref && { audioCaptureDefaults: { deviceId: { ideal: micPref } } }),
      ...(camPref && { videoCaptureDefaults: { deviceId: { ideal: camPref } } }),
    });
  }

  async connect(token: string, url: string): Promise<void> {
    this.ensureWired();
    await this.room.connect(url, token);
    this.wireSpeakingParticipant(this.room.localParticipant);
    // Publish microphone + camera. Mic denial is fatal for the call UX; camera
    // denial is soft — stay joined with cam off (tile shows "Camera off").
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
    } catch (error) {
      this.events.onError?.(mapProviderError(error));
    }
    try {
      await this.room.localParticipant.setCameraEnabled(true);
    } catch (error) {
      /*
       * The camera is soft: the call carries on into the tile that says
       * "Camera off". But swallowing the failure entirely made a browser that
       * refused the camera indistinguishable from one where nobody had turned
       * it on, and left an in-use camera reported by nothing at all. Say so
       * and stay joined -- the mic, at least, is working.
       */
      this.events.onError?.(mapProviderError(error));
    }
    this.emitLocal();
    this.refreshDevices();
    this.emitActiveDevices();
    this.applySpeakerPreference();
    for (const participant of this.room.remoteParticipants.values()) {
      this.wireSpeakingParticipant(participant);
      this.events.onParticipant?.(participantState(participant));
    }
  }

  disconnect(): void {
    this.room.disconnect();
  }

  /*
   * A toggle the device refuses has to be taken back.
   *
   * The session flips its own state the moment somebody presses, and waits for
   * this to confirm it. Dropping the rejection left the label saying "Camera
   * off" over a camera that had never come on -- and the press that would fix
   * it now reads as the press that broke it. Say what went wrong, then say
   * what the devices are actually doing.
   */
  setMicrophone(muted: boolean): void {
    void this.room.localParticipant.setMicrophoneEnabled(!muted).catch((error: unknown) => {
      this.events.onError?.(mapProviderError(error));
      this.emitLocal();
    });
  }

  setCamera(on: boolean): void {
    void this.room.localParticipant.setCameraEnabled(on).catch((error: unknown) => {
      this.events.onError?.(mapProviderError(error));
      this.emitLocal();
    });
  }

  async toggleScreenShare(): Promise<void> {
    const isSharing = this.room.localParticipant.isScreenShareEnabled;
    try {
      await this.room.localParticipant.setScreenShareEnabled(!isSharing);
      this.events.onLocalScreenShare?.(!isSharing);
    } catch (error: unknown) {
      this.events.onError?.(mapProviderError(error));
    }
  }

  async selectDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    await this.room.switchActiveDevice(mediaKind(kind), deviceId);
  }

  attachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void {
    const participant = this.findParticipant(identity);
    if (!participant) return;
    const source = kind === 'camera' ? Track.Source.Camera : Track.Source.Microphone;
    const publication = participant.getTrackPublication(source);
    const track = publication?.track;
    if (track) track.attach(element);
  }

  detachTrack(
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ): void {
    const participant = this.findParticipant(identity);
    if (!participant) return;
    const source = kind === 'camera' ? Track.Source.Camera : Track.Source.Microphone;
    const publication = participant.getTrackPublication(source);
    const track = publication?.track;
    if (track) track.detach(element);
  }

  onEvents(events: AvProviderEvents): void {
    this.events = events;
    this.ensureWired();
  }

  getRoom(): Room {
    return this.room;
  }

  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;

    this.room
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.wireSpeakingParticipant(participant);
        this.events.onParticipant?.(participantState(participant));
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.activeSpeakerIds.delete(participant.identity);
        this.events.onParticipantRemoved?.(participant.identity);
      })
      .on(RoomEvent.TrackMuted, (_pub: TrackPublication, participant: Participant) => {
        this.events.onParticipant?.(participantState(participant));
        if (participant === this.room.localParticipant) this.emitLocal();
      })
      .on(RoomEvent.TrackUnmuted, (_pub: TrackPublication, participant: Participant) => {
        this.events.onParticipant?.(participantState(participant));
        if (participant === this.room.localParticipant) this.emitLocal();
      })
      .on(RoomEvent.LocalTrackPublished, () => {
        this.emitLocal();
      })
      .on(RoomEvent.TrackSubscribed, (_track, _pub, participant: RemoteParticipant) => {
        this.events.onParticipant?.(participantState(participant));
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant: RemoteParticipant) => {
        this.events.onParticipant?.(participantState(participant));
      })
      /*
       * The SDK re-establishes a dropped socket on its own, usually within
       * seconds. That is news, not a teardown: reporting it through
       * Disconnected's full reset threw away every face in a room that was in
       * fact coming back. The session keeps everything and changes only what
       * it says about the call.
       */
      .on(RoomEvent.Reconnecting, () => {
        this.events.onReconnecting?.();
      })
      .on(RoomEvent.Reconnected, () => {
        this.events.onReconnected?.();
      })
      .on(RoomEvent.Disconnected, () => {
        this.events.onDisconnected?.();
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        this.refreshDevices();
      })
      .on(RoomEvent.MediaDevicesError, (error: Error) => {
      const swallowed = mapProviderError(error);
      void swallowed;
      })
      .on(RoomEvent.ActiveSpeakersChanged, (participants: Participant[]) => {
        this.handleActiveSpeakersChanged(participants);
      })
      .on(RoomEvent.ActiveDeviceChanged, (kind: MediaDeviceKind, deviceId: string) => {
        const appKind = deviceKind(kind);
        if (appKind) {
          this.events.onActiveDevice?.(appKind, deviceId);
        }
      });
  }

  private emitLocal(): void {
    const local = this.room.localParticipant;
    this.events.onLocalMic?.(!local.isMicrophoneEnabled);
    this.events.onLocalCamera?.(local.isCameraEnabled);
    this.events.onLocalSpeaking?.(local.isSpeaking);
  }

  private wireSpeakingParticipant(participant: Participant): void {
    participant.on(ParticipantEvent.IsSpeakingChanged, () => {
      this.emitParticipantSpeaking(participant);
    });
    participant.on(ParticipantEvent.ConnectionQualityChanged, () => {
      if (participant === this.room.localParticipant) {
        this.emitLocal();
        /*
         * emitLocal speaks of the mic, the camera and speaking; quality it
         * drops. The remote participants' quality is forwarded above, and the
         * local one is the uplink the lesson most depends on, so it goes out
         * on its own event and lands on the '__local__' entry.
         */
        this.events.onLocalQuality?.(mapConnectionQuality(participant.connectionQuality));
        return;
      }
      this.events.onParticipant?.(participantState(participant));
    });
  }

  private emitParticipantSpeaking(participant: Participant): void {
    if (participant === this.room.localParticipant) {
      this.events.onLocalSpeaking?.(participant.isSpeaking);
      return;
    }
    this.events.onParticipant?.(participantState(participant));
  }

  private handleActiveSpeakersChanged(participants: Participant[]): void {
    const nextIds = new Set(participants.map((participant) => participant.identity));
    const changedIds = new Set<string>([...this.activeSpeakerIds, ...nextIds]);
    this.activeSpeakerIds = nextIds;

    for (const identity of changedIds) {
      const participant = this.findParticipant(identity);
      if (!participant) continue;
      this.emitParticipantSpeaking(participant);
    }
  }

  /*
   * Enumeration is allowed to fail, and says so by rejecting.
   *
   * On a machine with no webcam `getLocalDevices('videoinput')` throws
   * NotFoundError, and `void` on a promise does not handle a rejection -- it
   * only silences the linter. What reached the console was an uncaught
   * NotFoundError with the page as its source, which reads like the board
   * broke rather than like a desktop that has never had a camera.
   *
   * A kind that cannot be enumerated has no devices, which is the truth and
   * is what the picker needs in order to leave itself out.
   */
  private refreshDevices(): void {
    void this.listDevices('microphone', 'audioinput');
    void this.listDevices('camera', 'videoinput');
    void this.listDevices('speaker', 'audiooutput');
  }

  private async listDevices(kind: DeviceKind, media: MediaDeviceKind): Promise<void> {
    try {
      const devices = await Room.getLocalDevices(media);
      this.events.onDevices?.(
        kind,
        devices.map((device) => ({ deviceId: device.deviceId, label: device.label })),
      );
    } catch {
      this.events.onDevices?.(kind, []);
    }
  }

  private findParticipant(identity: string): Participant | undefined {
    if (identity === '__local__' || this.room.localParticipant.identity === identity) {
      return this.room.localParticipant;
    }
    return this.room.remoteParticipants.get(identity);
  }

  private emitActiveDevices(): void {
    const micId = this.room.getActiveDevice('audioinput');
    if (micId) this.events.onActiveDevice?.('microphone', micId);

    const camId = this.room.getActiveDevice('videoinput');
    if (camId) this.events.onActiveDevice?.('camera', camId);

    const spkId = this.room.getActiveDevice('audiooutput');
    if (spkId) this.events.onActiveDevice?.('speaker', spkId);
  }

  private applySpeakerPreference(): void {
    const spkPref = readDevicePreference('speaker');
    if (spkPref) {
      void this.room.switchActiveDevice('audiooutput', spkPref).catch(() => {
        // Device preference is gone; let LiveKit use its own default.
      });
    }
  }
}

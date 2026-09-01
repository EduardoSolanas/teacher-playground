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

const MUTE_REQUEST_TOPIC = 'tp.av.mute-request';

function participantState(participant: Participant): ParticipantState {
  return {
    identity: participant.identity,
    micMuted: !participant.isMicrophoneEnabled,
    camOn: participant.isCameraEnabled,
    isSpeaking: participant.isSpeaking,
  };
}

function mediaKind(kind: DeviceKind): MediaDeviceKind {
  return kind === 'microphone' ? 'audioinput' : 'videoinput';
}

export class LiveKitProvider implements AvProvider {
  private readonly room = new Room();
  private events: AvProviderEvents = {};
  private wired = false;
  private activeSpeakerIds = new Set<string>();

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
    } catch {
      // leave camera off; MediaDevicesError also covers async device errors
    }
    this.emitLocal();
    this.refreshDevices();
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

  async selectDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    await this.room.switchActiveDevice(mediaKind(kind), deviceId);
  }

  requestMute(targetIdentity: string): void {
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: MUTE_REQUEST_TOPIC, target: targetIdentity }),
    );
    void this.room.localParticipant.publishData(payload, { reliable: true });
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
      .on(RoomEvent.Disconnected, () => {
        this.events.onDisconnected?.();
      })
      .on(RoomEvent.DataReceived, (payload, participant) => {
        this.handleData(payload, participant?.identity);
      })
      .on(RoomEvent.MediaDevicesChanged, () => {
        this.refreshDevices();
      })
      .on(RoomEvent.MediaDevicesError, (error: Error) => {
        this.events.onError?.(mapProviderError(error));
      })
      .on(RoomEvent.ActiveSpeakersChanged, (participants: Participant[]) => {
        this.handleActiveSpeakersChanged(participants);
      });
  }

  private handleData(payload: Uint8Array, _from: string | undefined): void {
    try {
      const message = JSON.parse(new TextDecoder().decode(payload)) as {
        type?: string;
        target?: string;
      };
      if (message.type !== MUTE_REQUEST_TOPIC) return;
      if (message.target !== this.room.localParticipant.identity) return;
      void this.room.localParticipant.setMicrophoneEnabled(false);
      this.events.onLocalMic?.(true);
    } catch {
      // ignore malformed peer data
    }
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
}

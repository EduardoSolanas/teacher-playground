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
  };
}

function mediaKind(kind: DeviceKind): MediaDeviceKind {
  return kind === 'microphone' ? 'audioinput' : 'videoinput';
}

export class LiveKitProvider implements AvProvider {
  private readonly room = new Room();
  private events: AvProviderEvents = {};
  private wired = false;

  async connect(token: string, url: string): Promise<void> {
    this.ensureWired();
    await this.room.connect(url, token);
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
        this.events.onParticipant?.(participantState(participant));
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
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
  }

  private refreshDevices(): void {
    void Room.getLocalDevices('audioinput').then((devices) => {
      this.events.onDevices?.(
        'microphone',
        devices.map((device) => device.deviceId),
      );
    });
    void Room.getLocalDevices('videoinput').then((devices) => {
      this.events.onDevices?.(
        'camera',
        devices.map((device) => device.deviceId),
      );
    });
  }

  private findParticipant(identity: string): Participant | undefined {
    if (identity === '__local__' || this.room.localParticipant.identity === identity) {
      return this.room.localParticipant;
    }
    return this.room.remoteParticipants.get(identity);
  }
}

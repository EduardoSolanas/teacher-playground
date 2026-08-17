/**
 * LiveKit provider adapter (browser client).
 *
 * Maps the `livekit-client` API onto the `AvProvider` seam used by the A/V
 * session state machine. This module is deliberately thin: all join/leave/
 * mute/camera/device/error transitions are orchestrated by `avSession.ts`,
 * which is fully unit-tested against a fake provider. Connecting this adapter
 * to a real LiveKit server requires a configured project (see README) and is
 * verified live rather than in CI.
 */

import {
  Room,
  RoomEvent,
  Participant,
  TrackEvent,
} from 'livekit-client';

import type {
  AvProvider,
  AvProviderEvents,
  DeviceKind,
  ParticipantState,
} from './avSession';
import { mapProviderError } from './avSession';

function participantState(participant: Participant): ParticipantState {
  return {
    identity: participant.identity,
    micMuted: !participant.isMicrophoneEnabled,
    camOn: participant.isCameraEnabled,
  };
}

export class LiveKitProvider implements AvProvider {
  private readonly room = new Room();
  private events: AvProviderEvents = {};

  connect(token: string, url: string): Promise<void> {
    return this.room.connect(url, token);
  }

  disconnect(): void {
    this.room.disconnect();
  }

  setMicrophone(muted: boolean): void {
    void this.room.localParticipant.setMicrophoneEnabled(!muted);
  }

  setCamera(on: boolean): void {
    void this.room.localParticipant.setCameraEnabled(on);
  }

  async selectDevice(kind: DeviceKind, deviceId: string): Promise<void> {
    if (kind === 'microphone') {
      await this.room.localParticipant.selectMicrophone(deviceId);
    } else {
      await this.room.localParticipant.selectCamera(deviceId);
    }
  }

  onEvents(events: AvProviderEvents): void {
    this.events = events;
    this.room
      .off()
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.emitParticipant(participant);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.events.onParticipantRemoved?.(participant.identity);
      })
      .on(RoomEvent.LocalTrackPublished, (track) => {
        this.events.onLocalCamera?.(this.room.localParticipant.isCameraEnabled);
        this.events.onLocalMic?.(!this.room.localParticipant.isMicrophoneEnabled);
        void this.emitForTrack(track.participant);
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        void this.emitForTrack(track.participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        void this.emitForTrack(track.participant);
      })
      .on(RoomEvent.Disconnected, () => {
        this.events.onDisconnected?.();
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === 'connected') {
          this.events.onLocalMic?.(!this.room.localParticipant.isMicrophoneEnabled);
          this.events.onLocalCamera?.(this.room.localParticipant.isCameraEnabled);
        }
      })
      .on(RoomEvent.Error, (error) => {
        this.events.onError?.(mapProviderError(error));
      });
  }

  private async emitForTrack(participant: Participant | undefined): Promise<void> {
    if (!participant) return;
    this.events.onParticipant?.(participantState(participant));
  }

  private emitParticipant(participant: Participant): void {
    this.events.onParticipant?.(participantState(participant));
  }
}

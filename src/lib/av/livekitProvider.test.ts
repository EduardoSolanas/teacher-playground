import { beforeEach, describe, expect, it, vi } from 'vitest';

const livekit = vi.hoisted(() => {
  const roomOn = vi.fn();
  const roomConnect = vi.fn(async () => {});
  const roomDisconnect = vi.fn();
  const publishData = vi.fn();
  const setMicrophoneEnabled = vi.fn(async () => {});
  const setCameraEnabled = vi.fn(async () => {});
  const switchActiveDevice = vi.fn(async () => {});
  const getLocalDevices = vi.fn(async () => []);

  const localParticipant = {
    identity: 'local-peer',
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    isSpeaking: false,
    setMicrophoneEnabled,
    setCameraEnabled,
    publishData,
    on: vi.fn(),
    getTrackPublication: vi.fn(),
  };

  const remoteParticipant = {
    identity: 'peer-2',
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    isSpeaking: false,
    connectionQuality: 'excellent',
    on: vi.fn(),
    getTrackPublication: vi.fn(),
  };

  const room = {
    connect: roomConnect,
    disconnect: roomDisconnect,
    on: roomOn,
    switchActiveDevice,
    localParticipant,
    remoteParticipants: new Map<string, typeof remoteParticipant>(),
  };

  return {
    roomOn,
    roomConnect,
    roomDisconnect,
    publishData,
    setMicrophoneEnabled,
    setCameraEnabled,
    switchActiveDevice,
    getLocalDevices,
    localParticipant,
    remoteParticipant,
    room,
  };
});

vi.mock('livekit-client', () => {
  enum RoomEvent {
    ParticipantConnected = 'participantConnected',
    ParticipantDisconnected = 'participantDisconnected',
    TrackMuted = 'trackMuted',
    TrackUnmuted = 'trackUnmuted',
    LocalTrackPublished = 'localTrackPublished',
    TrackSubscribed = 'trackSubscribed',
    TrackUnsubscribed = 'trackUnsubscribed',
    Disconnected = 'disconnected',
    DataReceived = 'dataReceived',
    MediaDevicesChanged = 'mediaDevicesChanged',
    MediaDevicesError = 'mediaDevicesError',
    ActiveSpeakersChanged = 'activeSpeakersChanged',
  }

  enum ConnectionQuality {
    Excellent = 'excellent',
    Good = 'good',
    Poor = 'poor',
    Lost = 'lost',
    Unknown = 'unknown',
  }

  enum ParticipantEvent {
    IsSpeakingChanged = 'isSpeakingChanged',
    ConnectionQualityChanged = 'connectionQualityChanged',
  }

  return {
    Room: Object.assign(
      class Room {
        connect = livekit.roomConnect;
        disconnect = livekit.roomDisconnect;
        on = livekit.roomOn;
        switchActiveDevice = livekit.switchActiveDevice;
        localParticipant = livekit.localParticipant;
        remoteParticipants = livekit.room.remoteParticipants;

        static getLocalDevices = livekit.getLocalDevices;
      },
      { getLocalDevices: livekit.getLocalDevices },
    ),
    RoomEvent,
    ParticipantEvent,
    ConnectionQuality,
    Track: { Source: { Camera: 'camera', Microphone: 'microphone' } },
  };
});

import { LiveKitProvider } from './livekitProvider';
import type { AvProviderEvents } from './avSession';

describe('LiveKitProvider speaking state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    livekit.room.remoteParticipants.clear();
    livekit.localParticipant.isMicrophoneEnabled = true;
    livekit.localParticipant.isCameraEnabled = true;
    livekit.localParticipant.isSpeaking = false;
    livekit.remoteParticipant.isMicrophoneEnabled = true;
    livekit.remoteParticipant.isCameraEnabled = true;
    livekit.remoteParticipant.isSpeaking = false;
    livekit.remoteParticipant.connectionQuality = 'excellent';
    livekit.localParticipant.on.mockReset();
    livekit.remoteParticipant.on.mockReset();
  });

  it('emits participant updates when LiveKit active speakers change', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    livekit.roomOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return livekit.room;
    });
    livekit.room.remoteParticipants.set(livekit.remoteParticipant.identity, livekit.remoteParticipant);

    const provider = new LiveKitProvider();
    const seen: Array<{
      identity: string;
      micMuted: boolean;
      camOn: boolean;
      isSpeaking: boolean;
      quality?: string;
    }> = [];
    const events: AvProviderEvents = {
      onParticipant: (participant) => {
        seen.push(participant);
      },
    };

    provider.onEvents(events);
    await provider.connect('token', 'wss://livekit.test');

    expect(livekit.remoteParticipant.on).toHaveBeenCalledWith('isSpeakingChanged', expect.any(Function));

    livekit.remoteParticipant.isSpeaking = true;
    handlers.get('activeSpeakersChanged')?.([livekit.remoteParticipant]);

    expect(seen).toContainEqual({
      identity: 'peer-2',
      micMuted: false,
      camOn: true,
      isSpeaking: true,
      quality: 'excellent',
    });

    livekit.remoteParticipant.isSpeaking = false;
    handlers.get('activeSpeakersChanged')?.([]);

    expect(seen).toContainEqual({
      identity: 'peer-2',
      micMuted: false,
      camOn: true,
      isSpeaking: false,
      quality: 'excellent',
    });
  });

  it('emits remote participant quality updates when LiveKit connection quality changes', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const participantHandlers = new Map<string, (...args: unknown[]) => void>();
    livekit.roomOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return livekit.room;
    });
    livekit.remoteParticipant.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      participantHandlers.set(event, handler);
      return livekit.remoteParticipant;
    });
    livekit.room.remoteParticipants.set(livekit.remoteParticipant.identity, livekit.remoteParticipant);

    const provider = new LiveKitProvider();
    const seen: Array<{
      identity: string;
      micMuted: boolean;
      camOn: boolean;
      isSpeaking: boolean;
      quality?: string;
    }> = [];

    provider.onEvents({
      onParticipant: (participant) => {
        seen.push(participant);
      },
    });
    await provider.connect('token', 'wss://livekit.test');

    expect(livekit.remoteParticipant.on).toHaveBeenCalledWith(
      'connectionQualityChanged',
      expect.any(Function),
    );

    livekit.remoteParticipant.connectionQuality = 'poor';
    participantHandlers.get('connectionQualityChanged')?.();

    expect(seen).toContainEqual({
      identity: 'peer-2',
      micMuted: false,
      camOn: true,
      isSpeaking: false,
      quality: 'poor',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Room, Track, RemoteParticipant } from 'livekit-client';

import AvSessionPanel from './AvSessionPanel';
import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { DeviceKind, AvDevice } from '@/lib/av/avSession';

const mic = (deviceId: string, label = `Microphone ${deviceId}`) => ({ deviceId, label });
const cam = (deviceId: string, label = `Camera ${deviceId}`) => ({ deviceId, label });

type AvOverrides = Partial<Omit<UseAvSessionResult, 'devices'>> & {
  devices?: Partial<Record<DeviceKind, AvDevice[]>>;
};

function addTrackPublication(
  participant: any,
  source: Track.Source,
  trackSid = `track-${source}-1`,
  overrides: Record<string, any> = {},
) {
  const mockTrack = {
    attach: vi.fn((el: HTMLMediaElement) => el),
    detach: vi.fn((el: HTMLMediaElement) => el),
  };
  const pub = {
    track: mockTrack,
    trackSid,
    source,
    isMuted: false,
    isSubscribed: true,
    ...overrides,
  };
  participant.trackPublications.set(trackSid, pub);
  if (source === Track.Source.Camera || source === Track.Source.ScreenShare) {
    participant.videoTrackPublications.set(trackSid, pub);
  } else if (source === Track.Source.Microphone) {
    participant.audioTrackPublications.set(trackSid, pub);
  }
  return pub;
}

function makeAv(overrides: AvOverrides = {}): UseAvSessionResult {
  const { devices, local, room, ...rest } = overrides;
  const realRoom = room === undefined ? new Room() : room;
  return {
    status: 'joined',
    error: null,
    unavailableReason: null,
    room: realRoom,
    participants: [],
    local: { micMuted: false, camOn: true, isScreenSharing: false, ...local },
    devices: { microphone: [mic('mic-1')], camera: [cam('cam-1')], speaker: [], ...devices },
    toggleMicrophone: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn().mockResolvedValue(undefined),
    selectDevice: vi.fn(),
    requestMute: vi.fn(),
    leave: vi.fn(),
    ...rest,
  };
}

describe('AvSessionPanel', () => {
  it('renders a local tile with VideoTrack when camera is on', () => {
    const room = new Room();
    addTrackPublication(room.localParticipant, Track.Source.Camera);
    const av = makeAv({ room, local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
    expect(screen.getByTestId('av-video-track-me')).toBeTruthy();
  });

  it('ends the call when asked, without leaving the room', () => {
    // A call that can be joined has to be leavable, and leaving it is not the
    // same as leaving the lesson -- the board carries on either way.
    const onEndCall = vi.fn();
    const av = makeAv();
    render(
      <AvSessionPanel av={av} localIdentity="me" onEndCall={onEndCall} />,
    );
    fireEvent.click(screen.getByTestId('av-end-call'));
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  it('leaves out the end control when there is nothing to end it with', () => {
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.queryByTestId('av-end-call')).toBeNull();
  });

  it('holds the mic and camera with the faces', () => {
    /*
     * The controls belong to the call, so they travel with it. Parked in the
     * top bar they were a fixed target, but the panel moves and fullscreens
     * now, and a mute button on the far side of the screen from the face you
     * are muting is a button you have to go looking for.
     *
     * It also puts them somewhere the guest hostname can reach: that side of a
     * lesson renders no top bar at all.
     */
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-call-controls')).toBeTruthy();
    fireEvent.click(screen.getByTestId('av-toggle-cam'));
    expect(av.toggleCamera).toHaveBeenCalledTimes(1);
  });

  it('defaults to rail mode and offers accessible rail, focus and off controls', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    expect(screen.getByRole('radiogroup', { name: 'Video layout' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Rail' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Focus' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('av-tiles-rail')).toBeTruthy();
  });

  it('turns tiles off without ending the call controls, and can return to rail', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(screen.queryByTestId('av-tile-me')).toBeNull();
    expect(screen.queryByTestId('av-tile-peer-1')).toBeNull();
    expect(screen.getByTestId('av-call-controls')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Rail' }));
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
    expect(screen.getByTestId('av-tile-peer-1')).toBeTruthy();
  });

  it('handles audio exclusively through RoomAudioRenderer with no manual audio elements', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    expect(screen.getByTestId('av-room-audio-renderer')).toBeTruthy();
    // §3.7: Assert that no manual <audio> elements are rendered
    expect(document.querySelectorAll('audio')).toHaveLength(0);

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));

    expect(screen.queryByTestId('av-tile-me')).toBeNull();
    expect(screen.queryByTestId('av-tile-peer-1')).toBeNull();
    expect(screen.getByTestId('av-call-controls')).toBeTruthy();
    expect(screen.getByTestId('av-room-audio-renderer')).toBeTruthy();
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });


  it('focuses the active speaker when nobody is pinned, then pins a tile into focus mode', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: true },
        { identity: 'peer-2', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    fireEvent.click(screen.getByRole('radio', { name: 'Focus' }));
    expect(screen.getByRole('radio', { name: 'Focus' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('av-focus-primary').getAttribute('data-participant')).toBe('peer-1');

    fireEvent.click(screen.getByRole('button', { name: 'Focus peer-2' }));
    expect(screen.getByRole('radio', { name: 'Focus' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('av-focus-primary').getAttribute('data-participant')).toBe('peer-2');
  });

  it('falls back to the first tile in focus mode when nobody is speaking', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    fireEvent.click(screen.getByRole('radio', { name: 'Focus' }));
    expect(screen.getByTestId('av-focus-primary').getAttribute('data-participant')).toBe('me');
  });

  it('can be got out of the way, and brought back', () => {
    /*
     * On a phone this is a fixed block across the top of the board. A lesson
     * spends most of its time drawing rather than looking at faces, so there
     * has to be a way to put it away -- and, since the call carries on behind
     * it, a way to get it back.
     */
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();

    fireEvent.click(screen.getByTestId('av-panel-collapse'));
    expect(screen.queryByTestId('av-tile-me')).toBeNull();

    fireEvent.click(screen.getByTestId('av-panel-open'));
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
  });

  it('starts out of the way when asked to', () => {
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" collapsed />);
    expect(screen.queryByTestId('av-tile-me')).toBeNull();
    expect(screen.getByTestId('av-panel-open')).toBeTruthy();
  });

  it('takes the full available width on mobile', () => {
    // On mobile screens, the call panel takes the full horizontal width with clean margins
    // so video tiles and action buttons have ample space and do not cramp.
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const panel = screen.getByTestId('av-session-panel');
    expect(panel.className).toContain('left-2');
    expect(panel.className).toContain('right-2');
  });

  it('names the microphones rather than reciting their ids', () => {
    // A device id is a forty-character hash. Three of those in a dropdown is
    // not a choice anybody can make; the label is the whole point of the menu.
    const av = makeAv({
      devices: {
        microphone: [mic('e181c4ad1c63', 'Headset (Jabra Evolve 65)'), mic('default', 'Default')],
        camera: [cam('cam-1')],
      },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const options = Array.from(screen.getByTestId('av-device-mic').querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toContain('Headset (Jabra Evolve 65)');
    expect(options.map((o) => o.textContent)).not.toContain('e181c4ad1c63');
  });

  it('numbers a device the browser has not named yet', () => {
    // Labels stay empty until a permission is granted. "Microphone 2" is still
    // something a person can pick between; a bare id is not.
    const av = makeAv({
      devices: { microphone: [mic('a', ''), mic('b', '')], camera: [cam('cam-1')] },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const options = Array.from(screen.getByTestId('av-device-mic').querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toContain('Microphone 2');
  });

  it('keeps the faces when one device is missing', () => {
    /*
     * A machine with no webcam still has a call on it. Replacing the whole
     * panel with the message hid a working conversation behind a complaint
     * about the half of it that was never going to work.
     */
    const av = makeAv({
      status: 'joined',
      error: { kind: 'device-missing', message: 'Requested device not found' },
      devices: { microphone: [mic('mic-1')], camera: [] },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
    expect(screen.getByTestId('av-status-message')).toBeTruthy();
  });

  it('says which device is missing, when it can tell', () => {
    // "No camera or microphone was found" over a working microphone reads as
    // the call being broken. The device lists already say which one it is.
    const noCam = makeAv({
      error: { kind: 'device-missing', message: 'not found' },
      devices: { microphone: [mic('mic-1')], camera: [] },
    });
    const { rerender } = render(<AvSessionPanel av={noCam} localIdentity="me" />);
    expect(screen.getByTestId('av-status-message').textContent).toContain('No camera');
    expect(screen.getByTestId('av-status-message').textContent).not.toContain('microphone');

    rerender(
      <AvSessionPanel
        av={makeAv({
          error: { kind: 'device-missing', message: 'not found' },
          devices: { microphone: [], camera: [cam('cam-1')] },
        })}
        localIdentity="me"
      />,
    );
    expect(screen.getByTestId('av-status-message').textContent).toContain('No microphone');
  });

  it('shows nothing to act on when there is no call at all', () => {
    // Unlike a missing device, these mean there is no call behind the message.
    const av = makeAv({ status: 'idle', unavailableReason: 'unconfigured' });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-status-message')).toBeTruthy();
    expect(screen.queryByTestId('av-tile-me')).toBeNull();
  });

  it('floats above the rest of the room', () => {
    /*
     * A panel that can be dragged anywhere has to outrank everything it can be
     * dragged over, or moving it toward an edge slides it under the furniture:
     * the top nav is 1100, the presence panel 1200 and its outside layer 1250,
     * the raised-hand cue 1300. The library and the shortcuts sheet (10001)
     * stay above it deliberately -- those take the screen over on purpose.
     */
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-session-panel').className).toContain('z-[1400]');

    fireEvent.click(screen.getByTestId('av-panel-collapse'));
    expect(screen.getByTestId('av-panel-open').className).toContain('z-[1400]');
  });

  it('moves when its handle is dragged', () => {
    /*
     * The panel sits over the board. Wherever it is put by default, it is
     * covering the part of the board somebody wants at some point in a lesson,
     * so it has to be movable out of the way rather than only hideable.
     */
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const panel = screen.getByTestId('av-session-panel');
    const handle = screen.getByTestId('av-panel-drag');

    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 190 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 190 });

    // Once moved by hand, the panel stops taking its place from the stylesheet.
    expect(panel.style.left).not.toBe('');
    expect(panel.style.top).not.toBe('');
    expect(panel.className).not.toContain('sm:bottom-16');
  });

  it('stays put when the drag never starts', () => {
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const panel = screen.getByTestId('av-session-panel');
    fireEvent.pointerMove(window, { clientX: 400, clientY: 400 });
    expect(panel.style.left).toBe('');
    expect(panel.className).toContain('sm:bottom-16');
  });

  it('leaves the pill where the panel was put', () => {
    // Moving the panel and then hiding it should not send it back to a corner
    // it was deliberately dragged out of.
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    fireEvent.pointerDown(screen.getByTestId('av-panel-drag'), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 220, clientY: 260 });
    fireEvent.pointerUp(window, { clientX: 220, clientY: 260 });
    const moved = screen.getByTestId('av-session-panel').style.left;

    fireEvent.click(screen.getByTestId('av-panel-collapse'));
    expect(screen.getByTestId('av-panel-open').style.left).toBe(moved);
  });

  it('positions the panel and collapsed pill below the Excalidraw toolbar on mobile by default', () => {
    const av = makeAv();
    const { unmount } = render(<AvSessionPanel av={av} localIdentity="me" />);
    const panel = screen.getByTestId('av-session-panel');
    expect(panel.className).toContain('top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)]');
    unmount();

    render(<AvSessionPanel av={av} localIdentity="me" collapsed />);
    const openBtn = screen.getByTestId('av-panel-open');
    expect(openBtn.className).toContain('top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)]');
  });


  it('offers a fullscreen control on every face', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-fullscreen-me')).toBeTruthy();
    expect(screen.getByTestId('av-fullscreen-peer-1')).toBeTruthy();
  });

  it('survives a browser with no fullscreen to give', () => {
    // jsdom has no Fullscreen API, and neither does an iframe denied the
    // permission. Pressing the button there must do nothing, not throw.
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(() => fireEvent.click(screen.getByTestId('av-fullscreen-me'))).not.toThrow();
  });

  it('shows "Camera off" placeholder when camOn is false', () => {
    const av = makeAv({
      participants: [{ identity: 'me', micMuted: false, micPresent: true, camOn: false, isSpeaking: false }],
      local: { micMuted: false, camOn: false },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const tile = screen.getByTestId('av-tile-me');
    expect(tile.textContent).toContain('Camera off');
    expect(tile.querySelector('video')).toBeNull();
  });


  it('renders remote participant tiles from the roster', () => {
    const av = makeAv({
      participants: [{ identity: 'peer-1', micMuted: true, micPresent: true, camOn: false, isSpeaking: false }],
      local: { micMuted: false, camOn: true },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-tile-peer-1')).toBeTruthy();
    expect(screen.getByTestId('av-tile-peer-1').textContent).toContain('Camera off');
  });

  it('shows a camera device picker when more than one camera is available', () => {
    const av = makeAv({
      devices: {
        microphone: [mic('mic-1')],
        camera: [cam('cam-1'), cam('cam-2')],
        speaker: [],
      },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-device-cam')).toBeTruthy();
  });

  it('does not show a camera device picker with a single camera', () => {
    const av = makeAv({
      devices: {
        microphone: [mic('mic-1')],
        camera: [cam('cam-1')],
        speaker: [],
      },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.queryByTestId('av-device-cam')).toBeNull();
  });

  it('shows a speaker device picker when more than one speaker is available', () => {
    const spk = (deviceId: string, label = `Speaker ${deviceId}`) => ({ deviceId, label });
    const av = makeAv({
      devices: {
        microphone: [mic('mic-1')],
        camera: [cam('cam-1')],
        speaker: [spk('spk-1'), spk('spk-2')],
      },
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-device-speaker')).toBeTruthy();
  });

  it('renders LiveKit RoomAudioRenderer and VideoTrack when room is present', () => {
    const mockTrack = {
      attach: vi.fn((el: HTMLMediaElement) => el),
      detach: vi.fn((el: HTMLMediaElement) => el),
    };
    const mockPublication = {
      track: mockTrack,
      trackSid: 'track-cam-1',
      source: 'camera',
      isMuted: false,
    };
    const mockMicPublication = {
      track: mockTrack,
      trackSid: 'track-mic-1',
      source: 'microphone',
      isMuted: false,
    };
    const localParticipant = {
      identity: 'me',
      isCameraEnabled: true,
      isMicrophoneEnabled: true,
      trackPublications: new Map([['track-cam-1', mockPublication], ['track-mic-1', mockMicPublication]]),
      videoTrackPublications: new Map([['track-cam-1', mockPublication]]),
      audioTrackPublications: new Map([['track-mic-1', mockMicPublication]]),
      getTrackPublication: vi.fn((source: string) => (source === 'camera' ? mockPublication : mockMicPublication)),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };
    const remoteParticipant = {
      identity: 'peer-1',
      isCameraEnabled: true,
      isMicrophoneEnabled: true,
      trackPublications: new Map([['track-cam-1', mockPublication], ['track-mic-1', mockMicPublication]]),
      videoTrackPublications: new Map([['track-cam-1', mockPublication]]),
      audioTrackPublications: new Map([['track-mic-1', mockMicPublication]]),
      getTrackPublication: vi.fn((source: string) => (source === 'camera' ? mockPublication : mockMicPublication)),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };
    const mockRoom = {
      name: 'room-1',
      state: 'connected',
      localParticipant,
      remoteParticipants: new Map([['peer-1', remoteParticipant]]),
      participants: new Map([['me', localParticipant], ['peer-1', remoteParticipant]]),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    const av = makeAv({
      room: mockRoom as unknown as UseAvSessionResult['room'],
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
      local: { micMuted: false, camOn: true },
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(mockRoom.disconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId('av-room-audio-renderer')).toBeTruthy();
    expect(screen.getByTestId('av-video-track-me')).toBeTruthy();
    expect(screen.getByTestId('av-video-track-peer-1')).toBeTruthy();
    expect(screen.getByTestId('av-video-track-me').className).toContain('-scale-x-100');
    expect(screen.getByTestId('av-video-track-peer-1').className).not.toContain('-scale-x-100');
  });

  it('highlights the speaking participant tile with an active speaker ring', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: true },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
      local: { micMuted: false, camOn: true },
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    const speakingTile = screen.getByTestId('av-tile-me');
    const silentTile = screen.getByTestId('av-tile-peer-1');

    expect(speakingTile.className).toContain('ring-2 ring-emerald-400');
    expect(silentTile.className).not.toContain('ring-2 ring-emerald-400');
  });

  it('displays connection quality warning when quality is poor or lost', () => {
    const av = makeAv({
      participants: [
        { identity: 'peer-poor', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, quality: 'poor' },
        { identity: 'peer-lost', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, quality: 'lost' },
        { identity: 'peer-good', micMuted: false, micPresent: true, camOn: true, isSpeaking: false, quality: 'excellent' },
      ],
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-quality-peer-poor')).toBeTruthy();
    expect(screen.getByTestId('av-quality-peer-poor').textContent).toContain('Poor');
    expect(screen.getByTestId('av-quality-peer-lost')).toBeTruthy();
    expect(screen.getByTestId('av-quality-peer-lost').textContent).toContain('Lost');
    expect(screen.queryByTestId('av-quality-peer-good')).toBeNull();
  });

  it('offers a Picture-in-Picture control on video tiles', () => {
    const room = new Room();
    addTrackPublication(room.localParticipant, Track.Source.Camera);
    const remote = new RemoteParticipant(room.engine.client, 'peer-1', 'peer-1');
    addTrackPublication(remote, Track.Source.Camera, 'track-remote-cam');
    room.remoteParticipants.set('peer-1', remote);
    const av = makeAv({
      room,
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    expect(screen.getByTestId('av-pip-me')).toBeTruthy();
    expect(screen.getByTestId('av-pip-peer-1')).toBeTruthy();
  });

  it('requests Picture-in-Picture on video element when PiP button is clicked', async () => {
    const room = new Room();
    addTrackPublication(room.localParticipant, Track.Source.Camera);
    const av = makeAv({ room, local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" />);

    const video = screen.getByTestId('av-tile-me').querySelector('video');
    expect(video).toBeTruthy();
    const requestPip = vi.fn().mockResolvedValue({} as PictureInPictureWindow);
    if (video) {
      (video as unknown as { requestPictureInPicture: unknown }).requestPictureInPicture = requestPip;
    }

    fireEvent.click(screen.getByTestId('av-pip-me'));
    expect(requestPip).toHaveBeenCalledTimes(1);
  });

  it('falls back to camera when screen share publication is inactive or unsubscribed', () => {
    const room = new Room();
    const remote = new RemoteParticipant(room.engine.client, 'peer-1', 'peer-1');
    addTrackPublication(remote, Track.Source.Camera, 'pub-cam-1');
    const screenPub = addTrackPublication(remote, Track.Source.ScreenShare, 'pub-screen-1', {
      isSubscribed: false,
      track: undefined,
    });
    room.remoteParticipants.set('peer-1', remote);


    const av = makeAv({
      room,
      participants: [
        { identity: 'peer-1', micMuted: false, micPresent: true, camOn: true, isSpeaking: false },
      ],
    });

    const { rerender } = render(<AvSessionPanel av={av} localIdentity="me" />);

    // Inactive screen share should NOT show screen badge and should render camera track instead
    expect(screen.queryByTestId('av-screenshare-badge-peer-1')).toBeNull();
    const videoTrack = screen.getByTestId('av-video-track-peer-1');
    expect(videoTrack).toBeTruthy();

    // Now make screen share live and subscribed
    screenPub.isSubscribed = true;
    screenPub.track = { attach: vi.fn(), detach: vi.fn() };
    rerender(<AvSessionPanel av={makeAv({ room, participants: av.participants })} localIdentity="me" />);

    expect(screen.getByTestId('av-screenshare-badge-peer-1')).toBeTruthy();
  });


  it('renders audio playback unlock button when browser blocks autoplay', () => {
    const mockTrack = {
      attach: vi.fn((el: HTMLMediaElement) => el),
      detach: vi.fn((el: HTMLMediaElement) => el),
    };
    const mockPublication = {
      track: mockTrack,
      trackSid: 'track-cam-1',
      source: 'camera',
      isMuted: false,
    };
    const localParticipant = {
      identity: 'me',
      isCameraEnabled: true,
      isMicrophoneEnabled: true,
      trackPublications: new Map([['track-cam-1', mockPublication]]),
      videoTrackPublications: new Map([['track-cam-1', mockPublication]]),
      audioTrackPublications: new Map(),
      getTrackPublication: vi.fn(() => mockPublication),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };
    const mockRoom = {
      name: 'room-1',
      state: 'connected',
      canPlaybackAudio: false,
      startAudio: vi.fn().mockResolvedValue(undefined),
      localParticipant,
      remoteParticipants: new Map(),
      participants: new Map([['me', localParticipant]]),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    const av = makeAv({
      room: mockRoom as unknown as UseAvSessionResult['room'],
      local: { micMuted: false, camOn: true },
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    const unlockBtn = screen.getByTestId('av-audio-unlock');
    expect(unlockBtn).toBeTruthy();
    expect(unlockBtn.textContent).toContain('Audio blocked');
    fireEvent.click(unlockBtn);
    expect(mockRoom.startAudio).toHaveBeenCalledTimes(1);
  });

  it('renders unmirrored VideoTrack when local participant shares screen', () => {
    const mockTrack = {
      attach: vi.fn((el: HTMLMediaElement) => el),
      detach: vi.fn((el: HTMLMediaElement) => el),
    };
    const mockScreenPublication = {
      track: mockTrack,
      trackSid: 'track-screen-1',
      source: 'screen_share',
      isMuted: false,
    };
    const localParticipant = {
      identity: 'me',
      isCameraEnabled: false,
      isMicrophoneEnabled: true,
      trackPublications: new Map([['track-screen-1', mockScreenPublication]]),
      videoTrackPublications: new Map([['track-screen-1', mockScreenPublication]]),
      audioTrackPublications: new Map(),
      getTrackPublication: vi.fn((source: string) => (source === 'screen_share' ? mockScreenPublication : undefined)),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };
    const mockRoom = {
      name: 'room-1',
      state: 'connected',
      localParticipant,
      remoteParticipants: new Map(),
      participants: new Map([['me', localParticipant]]),
      disconnect: vi.fn(),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      emit: vi.fn(),
    };

    const av = makeAv({
      room: mockRoom as unknown as UseAvSessionResult['room'],
      local: { micMuted: false, camOn: false, isScreenSharing: true },
    });

    render(<AvSessionPanel av={av} localIdentity="me" />);
    const videoTrack = screen.getByTestId('av-video-track-me');
    expect(videoTrack).toBeTruthy();
    expect(videoTrack.className).not.toContain('-scale-x-100');
  });

  it('displays human display names and initials instead of raw peer IDs on video tiles', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
        { identity: 'peer-alice', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
      ],
    });
    const users = [
      { peerId: 'me', userName: 'Teacher' },
      { peerId: 'peer-alice', userName: 'Alice Smith' },
    ];
    render(<AvSessionPanel av={av} localIdentity="me" users={users} />);

    const aliceTile = screen.getByTestId('av-tile-peer-alice');
    expect(aliceTile.textContent).toContain('Alice Smith');
    expect(aliceTile.textContent).toContain('AS');

    const meTile = screen.getByTestId('av-tile-me');
    expect(meTile.textContent).toContain('Teacher (you)');
  });

  it('shows hand-raised indicator on a participant tile when their hand is raised', () => {
    const av = makeAv({
      participants: [
        { identity: 'peer-bob', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
      ],
    });
    const users = [
      { peerId: 'peer-bob', userName: 'Bob', handRaised: true },
    ];
    render(<AvSessionPanel av={av} localIdentity="me" users={users} />);

    expect(screen.getByTestId('av-hand-raised-peer-bob')).toBeTruthy();
    expect(screen.getByTestId('av-hand-raised-peer-bob').textContent).toContain('Hand raised');
  });

  it('expands a single participant tile to full width in rail mode', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const tile = screen.getByTestId('av-tile-me');
    expect(tile.parentElement?.className).toContain('w-full');
    expect(tile.parentElement?.className).not.toContain('basis-44');
  });



  it('keeps multi-participant tiles in a scrollable rail', () => {
    const av = makeAv({
      participants: [
        { identity: 'me', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
        { identity: 'peer-alice', micMuted: false, micPresent: true, camOn: false, isSpeaking: false },
      ],
    });
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const meTile = screen.getByTestId('av-tile-me');
    expect(meTile.parentElement?.className).toContain('basis-44');
  });

  it('constrains max-height for responsive vertical scrolling', () => {
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" />);
    const panel = screen.getByTestId('av-session-panel');
    expect(panel.className).toContain('max-h-');
    expect(panel.className).toContain('overflow-y-auto');
  });
});



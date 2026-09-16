import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { micLevelPercent, PreJoinCheck } from './PreJoinCheck';

/*
 * jsdom has no media stack, so the environment boundary is stubbed the same
 * way useAvSession.test.tsx stubs global fetch: navigator.mediaDevices and
 * AudioContext stand in, and everything the component computes itself (error
 * mapping, level math, focus, cleanup) runs for real.
 */

const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();

function makeStream(kind: 'audio' | 'video') {
  const track = { kind, stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => (kind === 'audio' ? [track] : []),
    getVideoTracks: () => (kind === 'video' ? [track] : []),
  };
  return { stream, track };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  close = vi.fn(async () => undefined);

  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));

  createAnalyser = vi.fn(() => ({
    fftSize: 512,
    getFloatTimeDomainData: vi.fn((buffer: Float32Array) => {
      buffer.fill(0);
    }),
  }));

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

function primeMedia(audio: { stream: unknown }, video: { stream: unknown }) {
  getUserMedia.mockImplementation((constraints: { audio?: unknown; video?: unknown }) =>
    constraints.audio ? Promise.resolve(audio.stream) : Promise.resolve(video.stream),
  );
}

beforeEach(() => {
  getUserMedia.mockReset();
  enumerateDevices.mockReset();
  enumerateDevices.mockResolvedValue([
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Front mic' },
    { deviceId: 'mic-2', kind: 'audioinput', label: 'Headset mic' },
    { deviceId: 'cam-1', kind: 'videoinput', label: 'Front camera' },
  ]);
  // Device preferences persist in localStorage; one test's pick must not
  // seed the next test's initial selection.
  localStorage.clear();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices },
    configurable: true,
  });
  FakeAudioContext.instances.length = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  vi.unstubAllGlobals();
});

describe('PreJoinCheck', () => {
  it('renders the named dialog with preview, Join and Cancel', async () => {
    primeMedia(makeStream('audio'), makeStream('video'));
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={() => undefined} />);

    const root = screen.getByTestId('av-pre-join');
    expect(root).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Check your camera and microphone' })).toBeTruthy();
    expect(root.querySelector('[aria-modal="true"]')).toBeTruthy();
    await screen.findByTestId('av-pre-join-video');
    expect(screen.getByTestId('av-pre-join-confirm')).toBeTruthy();
    expect(screen.getByTestId('av-pre-join-cancel')).toBeTruthy();
    // Readiness is announced, not guessed: both halves succeeded here.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Camera and microphone are ready'),
    );
  });

  it('stops every track of both streams and confirms exactly once', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    const onConfirm = vi.fn();
    render(<PreJoinCheck onConfirm={onConfirm} onCancel={() => undefined} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('av-pre-join-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(audio.track.stop).toHaveBeenCalled();
    expect(video.track.stop).toHaveBeenCalled();
  });

  it('stops every track of both streams and cancels exactly once', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    const onCancel = vi.fn();
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={onCancel} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId('av-pre-join-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(audio.track.stop).toHaveBeenCalled();
    expect(video.track.stop).toHaveBeenCalled();
  });

  it('Escape cancels the check', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    const onCancel = vi.fn();
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={onCancel} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(audio.track.stop).toHaveBeenCalled();
    expect(video.track.stop).toHaveBeenCalled();
  });

  it('keeps the camera working when the microphone is refused', async () => {
    const video = makeStream('video');
    getUserMedia.mockImplementation((constraints: { audio?: unknown; video?: unknown }) => {
      if (constraints.audio) {
        return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      }
      return Promise.resolve(video.stream);
    });
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={() => undefined} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Microphone permission was denied');
    // The camera request still went out: one refusal does not cancel the other.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: false, video: true });
    expect(screen.getByTestId('av-pre-join-video')).toBeTruthy();
    // Join is always available; a soft failure is never a locked door.
    const confirm = screen.getByTestId('av-pre-join-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('restarts the microphone stream and stores the choice when another mic is picked', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={() => undefined} />);
    const select = await screen.findByTestId('av-pre-join-mic');
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    fireEvent.change(select, { target: { value: 'mic-2' } });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    // Only the audio half restarts, and it restarts on the chosen device.
    expect(getUserMedia.mock.calls[2][0]).toEqual({ audio: { deviceId: 'mic-2' }, video: false });
    expect(audio.track.stop).toHaveBeenCalled();
    expect(localStorage.getItem('whiteboard_call_device_microphone')).toBe('mic-2');
  });

  it('seeds the initial selection from the stored device preference', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    localStorage.setItem('whiteboard_call_device_microphone', 'mic-2');
    render(<PreJoinCheck onConfirm={() => undefined} onCancel={() => undefined} />);

    const select = await screen.findByTestId('av-pre-join-mic');
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect((select as HTMLSelectElement).value).toBe('mic-2');
    expect(getUserMedia.mock.calls[0][0]).toEqual({ audio: { deviceId: 'mic-2' }, video: false });
  });

  it('closes the meter and stops the tracks on unmount without throwing', async () => {
    const audio = makeStream('audio');
    const video = makeStream('video');
    primeMedia(audio, video);
    const { unmount } = render(<PreJoinCheck onConfirm={() => undefined} onCancel={() => undefined} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));

    expect(() => unmount()).not.toThrow();
    expect(audio.track.stop).toHaveBeenCalled();
    expect(video.track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
  });
});

describe('micLevelPercent', () => {
  it('maps silence to zero', () => {
    expect(micLevelPercent(new Float32Array(64))).toBe(0);
  });

  it('maps a loud input near full scale', () => {
    const loud = new Float32Array(64).fill(0.6);
    expect(micLevelPercent(loud)).toBeGreaterThanOrEqual(95);
  });

  it('maps a mid input between silence and full scale', () => {
    const mid = Array.from({ length: 64 }, () => 0.15);
    const level = micLevelPercent(mid);
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(95);
  });

  it('maps an empty input to zero', () => {
    expect(micLevelPercent([])).toBe(0);
  });
});

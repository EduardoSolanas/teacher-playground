import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import AvSessionPanel from './AvSessionPanel';
import type { UseAvSessionResult } from '@/hooks/useAvSession';

function makeAv(overrides: Partial<UseAvSessionResult> = {}): UseAvSessionResult {
  const attachTrack = vi.fn();
  const detachTrack = vi.fn();
  return {
    status: 'joined',
    error: null,
    unavailableReason: null,
    participants: [],
    local: { micMuted: false, camOn: true },
    devices: { microphone: ['mic-1'], camera: ['cam-1'] },
    toggleMicrophone: vi.fn(),
    toggleCamera: vi.fn(),
    selectDevice: vi.fn(),
    requestMute: vi.fn(),
    attachTrack,
    detachTrack,
    leave: vi.fn(),
    ...overrides,
  };
}

describe('AvSessionPanel', () => {
  it('renders a local tile', () => {
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
    expect(av.attachTrack).toHaveBeenCalledWith('me', 'camera', expect.any(HTMLVideoElement));
  });

  it('leaves the controls to the bar that now holds them', () => {
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.queryByTestId('av-call-controls')).toBeNull();
  });

  it('keeps the controls when there is no bar to hold them', () => {
    /*
     * The top nav is not rendered on the guest hostname, which is the student
     * side of a lesson. Without this the person most likely to need to mute in
     * a hurry would have nothing to press.
     */
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} showControls />);
    expect(screen.getByTestId('av-call-controls')).toBeTruthy();
    fireEvent.click(screen.getByTestId('av-toggle-cam'));
    expect(av.toggleCamera).toHaveBeenCalledTimes(1);
  });

  it('can be got out of the way, and brought back', () => {
    /*
     * On a phone this is a fixed block across the top of the board. A lesson
     * spends most of its time drawing rather than looking at faces, so there
     * has to be a way to put it away -- and, since the call carries on behind
     * it, a way to get it back.
     */
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();

    fireEvent.click(screen.getByTestId('av-panel-collapse'));
    expect(screen.queryByTestId('av-tile-me')).toBeNull();

    fireEvent.click(screen.getByTestId('av-panel-open'));
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
  });

  it('starts out of the way when asked to', () => {
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} collapsed />);
    expect(screen.queryByTestId('av-tile-me')).toBeNull();
    expect(screen.getByTestId('av-panel-open')).toBeTruthy();
  });

  it('stops short of the presence handle', () => {
    // The handle is `right-2 w-11`, pinned half way down the right edge. A
    // panel running to `right-2` sits on top of it, and the roster becomes
    // unreachable on the one screen size where it overlaps.
    const av = makeAv();
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    const panel = screen.getByTestId('av-session-panel');
    expect(panel.className).toContain('right-14');
    expect(panel.className).not.toContain(' right-2');
  });

  it('shows "Camera off" placeholder when camOn is false', () => {
    const av = makeAv({
      participants: [{ identity: 'me', micMuted: false, camOn: false }],
      local: { micMuted: false, camOn: false },
    });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    const tile = screen.getByTestId('av-tile-me');
    expect(tile.textContent).toContain('Camera off');
    expect(tile.querySelector('video')?.className).toContain('hidden');
  });

  it('renders remote participant tiles from the roster', () => {
    const av = makeAv({
      participants: [{ identity: 'peer-1', micMuted: true, camOn: false }],
      local: { micMuted: false, camOn: true },
    });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={true} />);
    expect(screen.getByTestId('av-tile-peer-1')).toBeTruthy();
    expect(screen.getByTestId('av-tile-peer-1').textContent).toContain('Camera off');
  });

  it('shows a camera device picker when more than one camera is available', () => {
    const av = makeAv({ devices: { microphone: ['mic-1'], camera: ['cam-1', 'cam-2'] } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.getByTestId('av-device-cam')).toBeTruthy();
  });

  it('does not show a camera device picker with a single camera', () => {
    const av = makeAv({ devices: { microphone: ['mic-1'], camera: ['cam-1'] } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.queryByTestId('av-device-cam')).toBeNull();
  });
});

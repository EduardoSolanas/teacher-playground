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
  it('renders a local tile and a camera toggle button', () => {
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    expect(screen.getByTestId('av-toggle-cam')).toBeTruthy();
    expect(screen.getByTestId('av-tile-me')).toBeTruthy();
    expect(av.attachTrack).toHaveBeenCalledWith('me', 'camera', expect.any(HTMLVideoElement));
  });

  it('camera toggle calls av.toggleCamera', () => {
    const av = makeAv({ local: { micMuted: false, camOn: true } });
    render(<AvSessionPanel av={av} localIdentity="me" isLocalHost={false} />);
    fireEvent.click(screen.getByTestId('av-toggle-cam'));
    expect(av.toggleCamera).toHaveBeenCalledTimes(1);
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

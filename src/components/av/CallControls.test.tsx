import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import CallControls from './CallControls';
import type { UseAvSessionResult } from '@/hooks/useAvSession';

import type { DeviceKind, AvDevice } from '@/lib/av/avSession';

const mic = (deviceId: string, label = `Microphone ${deviceId}`) => ({ deviceId, label });
const cam = (deviceId: string, label = `Camera ${deviceId}`) => ({ deviceId, label });

type AvOverrides = Partial<Omit<UseAvSessionResult, 'devices'>> & {
  devices?: Partial<Record<DeviceKind, AvDevice[]>>;
};

function makeAv(overrides: AvOverrides = {}): UseAvSessionResult {
  const { devices, local, ...rest } = overrides;
  return {
    status: 'joined',
    error: null,
    unavailableReason: null,
    room: null,
    participants: [],
    local: { micMuted: false, camOn: true, isScreenSharing: false, ...local },
    devices: { microphone: [mic('mic-1')], camera: [cam('cam-1')], speaker: [], ...devices },
    toggleMicrophone: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn().mockResolvedValue(undefined),
    selectDevice: vi.fn(),
    requestMute: vi.fn(),
    attachTrack: vi.fn(),
    detachTrack: vi.fn(),
    leave: vi.fn(),
    ...rest,
  };
}

describe('CallControls', () => {
  it('offers the mic and camera toggles', () => {
    const av = makeAv();
    render(<CallControls av={av} />);

    fireEvent.click(screen.getByTestId('av-toggle-mic'));
    fireEvent.click(screen.getByTestId('av-toggle-cam'));
    expect(av.toggleMicrophone).toHaveBeenCalledTimes(1);
    expect(av.toggleCamera).toHaveBeenCalledTimes(1);
  });

  it('names the action rather than the state', () => {
    // A button that reads "Mute" mutes: the label is what pressing it does,
    // which is the only reading that survives someone glancing at it mid-lesson.
    const live = makeAv({ local: { micMuted: false, camOn: true, isScreenSharing: false } });
    const { rerender } = render(<CallControls av={live} />);
    expect(screen.getByTestId('av-toggle-mic').textContent).toBe('Mute');
    expect(screen.getByTestId('av-toggle-cam').textContent).toBe('Camera off');
    expect(screen.getByTestId('av-toggle-screen').textContent).toBe('Share screen');

    rerender(<CallControls av={makeAv({ local: { micMuted: true, camOn: false, isScreenSharing: true } })} />);
    expect(screen.getByTestId('av-toggle-mic').textContent).toBe('Unmute');
    expect(screen.getByTestId('av-toggle-cam').textContent).toBe('Camera on');
    expect(screen.getByTestId('av-toggle-screen').textContent).toBe('Stop sharing');
  });

  it('calls toggleScreenShare when screen share button is clicked', () => {
    const av = makeAv();
    render(<CallControls av={av} />);

    fireEvent.click(screen.getByTestId('av-toggle-screen'));
    expect(av.toggleScreenShare).toHaveBeenCalledTimes(1);
  });

  it('says where the call has got to', () => {
    const { rerender } = render(<CallControls av={makeAv({ status: 'connecting' })} />);
    expect(screen.getByTestId('av-call-status').textContent).toContain('connecting');

    rerender(<CallControls av={makeAv({ status: 'joined' })} />);
    expect(screen.getByTestId('av-call-status').textContent).toContain('live');
  });

  it('disables the toggles until there is a call to act on', () => {
    // The session refuses a toggle before it has joined, so an enabled button
    // in those states is a button that does nothing when pressed.
    for (const status of ['idle', 'connecting', 'error'] as const) {
      const { unmount } = render(<CallControls av={makeAv({ status })} />);
      expect(screen.getByTestId('av-toggle-mic').hasAttribute('disabled')).toBe(true);
      expect(screen.getByTestId('av-toggle-cam').hasAttribute('disabled')).toBe(true);
      unmount();
    }
  });

  it('leaves the toggles live once the call is up', () => {
    render(<CallControls av={makeAv({ status: 'joined' })} />);
    expect(screen.getByTestId('av-toggle-mic').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('av-toggle-cam').hasAttribute('disabled')).toBe(false);
  });

  it('keeps the status out of the way when the bar is narrow', () => {
    // The header is three rem tall with a back link and an avatar already in
    // it; the status is the part that can go when there is no room for it.
    render(<CallControls av={makeAv()} />);
    expect(screen.getByTestId('av-call-status').className).toContain('hidden');
    expect(screen.getByTestId('av-call-status').className).toContain('sm:inline');
  });
});

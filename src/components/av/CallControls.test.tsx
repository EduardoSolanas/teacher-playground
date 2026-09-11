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
    canPublish: true,
    room: null,
    participants: [],
    local: { micMuted: false, camOn: true, isScreenSharing: false, ...local },
    devices: { microphone: [mic('mic-1')], camera: [cam('cam-1')], speaker: [], ...devices },
    activeDevices: { microphone: undefined, camera: undefined, speaker: undefined },
    toggleMicrophone: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn().mockResolvedValue(undefined),
    selectDevice: vi.fn(),
    requestMute: vi.fn(),
    retry: vi.fn(),
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

  it('keeps a stable accessible name and reports the state on aria-pressed', () => {
    /*
     * The name is the control's identity and must not move; the state lives on
     * aria-pressed. Action labels plus aria-pressed read backwards -- a muted
     * mic announced "Unmute, pressed" -- and the visible title keeps the
     * action for the sighted reading.
     */
    const live = makeAv({ local: { micMuted: false, camOn: true, isScreenSharing: false } });
    const { rerender } = render(<CallControls av={live} />);
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Camera' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Screen share' })).toBeTruthy();
    expect(screen.getByTestId('av-toggle-mic').getAttribute('title')).toBe('Mute');

    rerender(<CallControls av={makeAv({ local: { micMuted: true, camOn: false, isScreenSharing: true } })} />);
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Unmute/ })).toBeNull();
    expect(screen.getByTestId('av-toggle-mic').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('av-toggle-mic').getAttribute('title')).toBe('Unmute');
    expect(screen.getByTestId('av-toggle-cam').getAttribute('title')).toBe('Camera on');
    expect(screen.getByTestId('av-toggle-screen').getAttribute('title')).toBe('Stop sharing');
  });

  it('keeps the controls to icons so three of them fit the rail', () => {
    // The rail is clamp(11rem,18vw,15rem) wide. Three text labels in it
    // overlapped and clipped one another; the meaning is on the accessible
    // name, with the action on the title for a pointer.
    const av = makeAv();
    render(<CallControls av={av} />);
    for (const id of ['av-toggle-mic', 'av-toggle-cam', 'av-toggle-screen']) {
      const button = screen.getByTestId(id);
      expect(button.textContent).toBe('');
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.getAttribute('title')).toBeTruthy();
    }
  });


  it('reports mic and camera state to assistive tech, not only in colour', () => {
    /*
     * Muted and camera-off are filled solid red so they read at a glance, which
     * is what both Pencil Spaces and Lessonspace do. Colour alone is not a
     * signal, so the same state is on aria-pressed as well.
     */
    const off = makeAv({ local: { micMuted: true, camOn: false, isScreenSharing: false } });
    const { unmount } = render(<CallControls av={off} />);
    expect(screen.getByTestId('av-toggle-mic').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('av-toggle-cam').getAttribute('aria-pressed')).toBe('true');
    unmount();

    const live = makeAv({ local: { micMuted: false, camOn: true, isScreenSharing: false } });
    render(<CallControls av={live} />);
    expect(screen.getByTestId('av-toggle-mic').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('av-toggle-cam').getAttribute('aria-pressed')).toBe('false');
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

    rerender(<CallControls av={makeAv({ status: 'reconnecting' })} />);
    expect(screen.getByTestId('av-call-status').textContent).toContain('reconnecting');

    rerender(<CallControls av={makeAv({ status: 'joined' })} />);
    expect(screen.getByTestId('av-call-status').textContent).toContain('live');
  });

  it('announces the call state as it changes', () => {
    // The chip is the only thing that says the call dropped and is coming
    // back, so it has to be a live region rather than a visual-only label.
    render(<CallControls av={makeAv({ status: 'reconnecting' })} />);
    const status = screen.getByTestId('av-call-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
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

  it('leaves the toggles live once the call is up, including while reconnecting', () => {
    const { rerender } = render(<CallControls av={makeAv({ status: 'joined' })} />);
    expect(screen.getByTestId('av-toggle-mic').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('av-toggle-cam').hasAttribute('disabled')).toBe(false);

    // A dropped socket does not take the tracks with it: the session accepts a
    // toggle mid-drop, and the teacher most needs the mic when the call is
    // struggling -- disabling it there is the worst moment for a dead button.
    rerender(<CallControls av={makeAv({ status: 'reconnecting' })} />);
    expect(screen.getByTestId('av-toggle-mic').hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('av-toggle-cam').hasAttribute('disabled')).toBe(false);
  });

  it('shows the status on phones too', () => {
    // The chip used to be `hidden sm:inline-flex`, so the one device most
    // likely to be on a flaky connection had no way to see the call was back.
    render(<CallControls av={makeAv()} />);
    const classes = screen.getByTestId('av-call-status').className;
    expect(classes).toContain('inline-flex');
    expect(classes.split(/\s+/)).not.toContain('hidden');
  });

  it('arranges action buttons in a balanced 3-column grid', () => {
    render(<CallControls av={makeAv()} />);
    const buttons = screen.getByTestId('av-call-buttons');
    expect(buttons.className).toContain('grid');
    expect(buttons.className).toContain('grid-cols-3');
  });

  it('explains why a viewer cannot use the controls', () => {
    // A viewer's token cannot publish. Leaving the buttons enabled and
    // letting them fail opaquely reads as the application being broken.
    const av = makeAv({ canPublish: false });
    render(<CallControls av={av} />);

    expect(screen.getByTestId('av-view-only').textContent).toContain('View-only');
    for (const id of ['av-toggle-mic', 'av-toggle-cam', 'av-toggle-screen']) {
      expect(screen.getByTestId(id).hasAttribute('disabled')).toBe(true);
    }
  });

  it('sizes the call toggles for the pointer rather than blanket 44px', () => {
    /*
     * 44px everywhere over-applied on the desktop rail, where the controls
     * are reached with a mouse. A coarse pointer keeps the touch-sized
     * target; a fine pointer gets a compact one.
     */
    render(<CallControls av={makeAv()} />);
    for (const id of ['av-toggle-mic', 'av-toggle-cam', 'av-toggle-screen']) {
      const classes = screen.getByTestId(id).className.split(/\s+/);
      expect(classes).toContain('pointer-coarse:min-h-11');
      expect(classes).toContain('min-h-9');
      expect(classes).not.toContain('min-h-11');
    }
  });
});


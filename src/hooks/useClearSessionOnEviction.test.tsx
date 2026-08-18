import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { useClearSessionOnEviction } from './useClearSessionOnEviction';

function Probe({
  wasKicked = false,
  wasRejected = false,
  wasSuspended = false,
  clearSession,
}: {
  wasKicked?: boolean;
  wasRejected?: boolean;
  wasSuspended?: boolean;
  clearSession: () => void;
}) {
  useClearSessionOnEviction(clearSession, { wasKicked, wasRejected, wasSuspended });
  return null;
}

describe('useClearSessionOnEviction (SEC-011)', () => {
  it('clears session material when the local user is rejected', () => {
    const clearSession = vi.fn();
    render(
      <Probe wasRejected clearSession={clearSession} />,
    );
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it('clears session material when the local user is suspended', () => {
    const clearSession = vi.fn();
    render(
      <Probe wasSuspended clearSession={clearSession} />,
    );
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it('does not clear while the local user is only waiting', () => {
    const clearSession = vi.fn();
    render(<Probe clearSession={clearSession} />);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('clears session material once on window pagehide', () => {
    const clearSession = vi.fn();
    render(<Probe clearSession={clearSession} />);
    expect(clearSession).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));
    expect(clearSession).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    expect(clearSession).toHaveBeenCalledTimes(1);
  });
});

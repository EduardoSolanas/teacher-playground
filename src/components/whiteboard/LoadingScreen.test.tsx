import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoadingScreen from './LoadingScreen';

describe('LoadingScreen announcements (UX-A25)', () => {
  it('announces the connecting text politely', () => {
    render(<LoadingScreen />);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Connecting to room…');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('announces the error assertively', () => {
    render(<LoadingScreen error="Reconnect failed" />);

    expect(screen.getByRole('alert').textContent).toBe('Reconnect failed');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import SyncDegradedNotice from './SyncDegradedNotice';

describe('SyncDegradedNotice', () => {
  it('renders status message informing drawing updates may be delayed', () => {
    render(<SyncDegradedNotice />);
    const notice = screen.getByTestId('whiteboard-sync-degraded');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain('Sync degraded. Drawing updates may be delayed.');
  });

  it('announces itself to assistive technology with role="status"', () => {
    render(<SyncDegradedNotice />);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

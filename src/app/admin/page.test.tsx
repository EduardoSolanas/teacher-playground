import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import AdminPage from './page';

describe('AdminPage', () => {
  it('renders the admin heading and the users panel', async () => {
    render(<AdminPage />);

    expect(screen.getByRole('heading', { level: 1, name: /admin/i })).toBeTruthy();
    expect(screen.getByTestId('admin-users-sub').textContent).toBe(
      'All Teacher Playground accounts, newest first.',
    );
    expect(screen.getByTestId('admin-loading')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('admin-loading')).toBeNull();
    });
    expect(screen.getByTestId('admin-load-error')).toBeTruthy();
    expect(screen.queryByTestId('admin-users-sub')).toBeNull();
  });
});

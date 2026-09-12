import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import CompanyPage from './page';

describe('CompanyPage', () => {
  it('renders the company heading and the admin panel', async () => {
    render(<CompanyPage />);

    expect(screen.getByRole('heading', { level: 1, name: /company/i })).toBeTruthy();
    expect(screen.getByTestId('company-loading')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTestId('company-loading')).toBeNull();
    });
  });
});

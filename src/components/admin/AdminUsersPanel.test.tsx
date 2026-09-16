import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminUsersPanel from './AdminUsersPanel';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Seeded oldest-first on purpose: the panel owns the presentation order, so
// the row order in the DOM is the assertion, not the payload order.
const createdAtOld = Date.UTC(2026, 0, 15);
const createdAtNew = Date.UTC(2026, 2, 1);
const updatedAtOld = Date.UTC(2026, 1, 2);
const updatedAtNew = Date.UTC(2026, 4, 20);

const usersBody = {
  accounts: [
    {
      accountId: 'acc_older',
      state: 'active',
      provenance: 'cloudflare_access',
      displayName: null,
      createdAt: createdAtOld,
      updatedAt: updatedAtOld,
    },
    {
      accountId: 'acc_newer',
      state: 'disabled',
      provenance: 'guest_upgrade',
      displayName: 'Ada Lovelace',
      createdAt: createdAtNew,
      updatedAt: updatedAtNew,
    },
  ],
  total: 2,
};

function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

describe('AdminUsersPanel account list', () => {
  it('announces loading, then renders the table newest first with the total line', async () => {
    let resolveUsers: (response: Response) => void = () => undefined;
    const request: AjaxFetch = () =>
      new Promise<Response>((resolve) => {
        resolveUsers = resolve;
      });

    render(<AdminUsersPanel request={request} />);
    expect(screen.getByTestId('admin-users-sub').textContent).toBe(
      'All Teacher Playground accounts, newest first.',
    );
    expect(screen.getByTestId('admin-loading').textContent).toMatch(/loading/i);
    expect(screen.getByTestId('admin-loading').getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('admin-users-table')).toBeNull();

    await act(async () => {
      resolveUsers(jsonResponse(200, usersBody));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('admin-loading')).toBeNull();
    });
    expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    expect(screen.getByTestId('admin-users-total').textContent).toContain('2 accounts');
    expect(screen.getByTestId('admin-users-sub').textContent).toBe(
      'All Teacher Playground accounts, newest first.',
    );
    expect(screen.queryByTestId('admin-users-showing')).toBeNull();

    const rows = screen
      .getAllByTestId(/^admin-user-/)
      .map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual(['admin-user-acc_newer', 'admin-user-acc_older']);

    const newestRow = screen.getByTestId('admin-user-acc_newer');
    expect(newestRow.textContent).toContain('Ada Lovelace');
    expect(newestRow.textContent).toContain('guest_upgrade');
    expect(newestRow.textContent).toContain('disabled');
    expect(newestRow.textContent).toContain(shortDate(createdAtNew));
    expect(newestRow.textContent).toContain(shortDate(updatedAtNew));
    const olderRow = screen.getByTestId('admin-user-acc_older');
    expect(olderRow.textContent).toContain('cloudflare_access');
    expect(olderRow.textContent).toContain('active');
  });

  it('renders an em-dash for an account without a display name', async () => {
    const request: AjaxFetch = async () => jsonResponse(200, usersBody);

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-user-acc_older')).toBeTruthy();
    });
    const fallbackRow = screen.getByTestId('admin-user-acc_older');
    expect(fallbackRow.textContent).toContain('—');
    expect(fallbackRow.textContent).not.toContain('null');
  });

  it('renders a full-width table with the brand compare padding and hairlines', async () => {
    render(<AdminUsersPanel request={async () => jsonResponse(200, usersBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    expect(table.className).toContain('w-full');
    expect(table.className).toContain('min-w-[40rem]');
    expect(table.className).toContain('border-[color:var(--line)]');
    expect(table.className).toContain('text-[0.94rem]');
    expect(table.parentElement?.className).toContain('overflow-x-auto');

    const headCells = Array.from(table.querySelectorAll('thead th'));
    expect(headCells).toHaveLength(5);
    const bodyCells = Array.from(table.querySelectorAll('tbody td'));
    expect(bodyCells).toHaveLength(10);
    for (const cell of [...headCells, ...bodyCells]) {
      expect(cell.className).toContain('px-[0.9rem]');
      expect(cell.className).toContain('py-[0.7rem]');
    }
    for (const th of headCells) {
      expect(th.className).toContain('bg-[color:var(--paper2)]');
      expect(th.className).toContain('border-b-[color:var(--rule)]');
    }
    for (const td of bodyCells) {
      expect(td.className).toContain('border-t-[color:var(--line)]');
      expect(td.className).toContain('text-[color:var(--ink2)]');
    }
  });

  it('says which slice is shown when the server total exceeds the returned rows', async () => {
    render(
      <AdminUsersPanel
        request={async () => jsonResponse(200, { accounts: usersBody.accounts, total: 43689 })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.getByTestId('admin-users-total').textContent).toContain('43689 accounts');
    expect(screen.getByTestId('admin-users-showing').textContent).toBe(
      'Showing the newest 2 of 43689 accounts.',
    );
  });

  it('shows a refusal instead of account data for a non-admin', async () => {
    const view = render(
      <AdminUsersPanel request={async () => jsonResponse(403, { error: 'Forbidden' })} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('admin-denied')).toBeTruthy();
    });
    expect(screen.getByTestId('admin-denied').getAttribute('role')).toBe('alert');
    const denied = screen.getByTestId('admin-denied');
    expect(denied.querySelector('h2')?.textContent).toBe('No access');
    expect(denied.textContent).not.toContain('Admin');
    expect(denied.textContent).toContain('You do not have access to this page.');
    expect(screen.queryByTestId('admin-users-table')).toBeNull();
    expect(screen.queryByTestId('admin-users-sub')).toBeNull();
    expect(view.container.textContent).not.toContain('All Teacher Playground accounts');
    expect(view.container.textContent).not.toContain('acc_newer');
    expect(view.container.textContent).not.toContain('acc_older');
  });

  it('shows the same refusal when the admin surface is disabled', async () => {
    const view = render(
      <AdminUsersPanel request={async () => jsonResponse(404, { error: 'Not found' })} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('admin-denied')).toBeTruthy();
    });
    expect(screen.getByTestId('admin-denied').textContent).toContain(
      'You do not have access to this page.',
    );
    const denied = screen.getByTestId('admin-denied');
    expect(denied.querySelector('h2')?.textContent).toBe('No access');
    expect(denied.textContent).not.toContain('Admin');
    expect(screen.queryByTestId('admin-users-table')).toBeNull();
    expect(screen.queryByTestId('admin-users-sub')).toBeNull();
    expect(view.container.textContent).not.toContain('All Teacher Playground accounts');
    expect(view.container.textContent).not.toContain('acc_newer');
    expect(view.container.textContent).not.toContain('acc_older');
  });

  it('recovers into the table when the first load throws and Retry succeeds', async () => {
    let attempts = 0;
    const request: AjaxFetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network down');
      return jsonResponse(200, usersBody);
    };

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-load-error').textContent).toMatch(/could not load/i);
    });
    expect(screen.queryByTestId('admin-users-table')).toBeNull();
    expect(screen.getByTestId('admin-load-error').getAttribute('role')).toBe('alert');

    fireEvent.click(screen.getByTestId('admin-load-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.queryByTestId('admin-load-error')).toBeNull();
    expect(attempts).toBe(2);
  });

  it('offers the same recovery when the server answers 500', async () => {
    let attempts = 0;
    const request: AjaxFetch = async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(500, { error: 'boom' })
        : jsonResponse(200, usersBody);
    };

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-load-error').textContent).toMatch(/could not load/i);
    });

    fireEvent.click(screen.getByTestId('admin-load-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.queryByTestId('admin-load-error')).toBeNull();
  });

  it('shows the load error when the payload is unreadable', async () => {
    render(<AdminUsersPanel request={async () => jsonResponse(200, { accounts: null })} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-load-error').textContent).toMatch(/could not load/i);
    });
    expect(screen.queryByTestId('admin-users-table')).toBeNull();
    expect(screen.queryByTestId('admin-users-sub')).toBeNull();
  });

  it('stops updating after unmount while the first load is in flight', async () => {
    let resolveUsers: (response: Response) => void = () => undefined;
    const request: AjaxFetch = () =>
      new Promise<Response>((resolve) => {
        resolveUsers = resolve;
      });

    const view = render(<AdminUsersPanel request={request} />);
    expect(screen.getByTestId('admin-loading')).toBeTruthy();

    view.unmount();
    await act(async () => {
      resolveUsers(jsonResponse(200, usersBody));
      await Promise.resolve();
    });

    expect(view.container.innerHTML).toBe('');
  });
});

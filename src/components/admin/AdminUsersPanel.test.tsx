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
      organisation: null,
      plan: null,
      planStatus: null,
      rooms: 0,
      createdAt: createdAtOld,
      updatedAt: updatedAtOld,
    },
    {
      accountId: 'acc_newer',
      state: 'disabled',
      provenance: 'guest_upgrade',
      displayName: 'Ada Lovelace',
      organisation: 'Aster Tutoring',
      plan: 'tutor_pro_monthly',
      planStatus: 'active',
      rooms: 3,
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

  it('renders the columns from the payload in the preferred order', async () => {
    render(<AdminUsersPanel request={async () => jsonResponse(200, usersBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-user-acc_newer')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual([
      'Display name',
      'Organisation',
      'Plan',
      'Plan status',
      'Rooms',
      'Provenance',
      'State',
      'Created',
      'Updated',
      'Account id',
    ]);

    // The middot plan cell is gone by design: plan and planStatus are their
    // own columns, and the accountId column closes the row.
    const newestCells = Array.from(
      screen.getByTestId('admin-user-acc_newer').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(newestCells).toEqual([
      'Ada Lovelace',
      'Aster Tutoring',
      'tutor_pro_monthly',
      'active',
      '3',
      'guest_upgrade',
      'disabled',
      shortDate(createdAtNew),
      shortDate(updatedAtNew),
      'acc_newer',
    ]);

    // No membership and no entitlement row: em-dashes, not nulls or zeros
    // pretending to be data.
    const olderCells = Array.from(
      screen.getByTestId('admin-user-acc_older').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(olderCells[1]).toBe('—');
    expect(olderCells[2]).toBe('—');
    expect(olderCells[3]).toBe('—');
    expect(olderCells[9]).toBe('acc_older');
  });

  it('renders an unknown backend field as a column after the known ones', async () => {
    const extendedBody = {
      accounts: [usersBody.accounts[0], { ...usersBody.accounts[1], loginCount: 7 }],
      total: 2,
    };
    render(<AdminUsersPanel request={async () => jsonResponse(200, extendedBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual([
      'Display name',
      'Organisation',
      'Plan',
      'Plan status',
      'Rooms',
      'Provenance',
      'State',
      'Created',
      'Updated',
      'Account id',
      'Login Count',
    ]);

    const newestCells = Array.from(
      screen.getByTestId('admin-user-acc_newer').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(newestCells).toHaveLength(11);
    expect(newestCells[10]).toBe('7');
  });

  it('yields one column for a key only some rows carry, em-dash on the rest', async () => {
    const partialBody = {
      accounts: [{ ...usersBody.accounts[0], signupSource: 'invite' }, usersBody.accounts[1]],
      total: 2,
    };
    render(<AdminUsersPanel request={async () => jsonResponse(200, partialBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers.filter((header) => header === 'Signup Source')).toHaveLength(1);
    expect(headers[headers.length - 1]).toBe('Signup Source');

    const olderCells = Array.from(
      screen.getByTestId('admin-user-acc_older').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(olderCells).toHaveLength(11);
    expect(olderCells[10]).toBe('invite');
    const newestCells = Array.from(
      screen.getByTestId('admin-user-acc_newer').querySelectorAll('td'),
    ).map((td) => td.textContent);
    expect(newestCells).toHaveLength(11);
    expect(newestCells[10]).toBe('—');
  });

  it('right-aligns the rooms column', async () => {
    render(<AdminUsersPanel request={async () => jsonResponse(200, usersBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    const headCells = Array.from(table.querySelectorAll('thead th'));
    expect(headCells[4].textContent).toBe('Rooms');
    expect(headCells[4].className).toContain('text-right');
    const bodyCells = Array.from(table.querySelectorAll('tbody td'));
    for (let index = 4; index < bodyCells.length; index += 10) {
      expect(bodyCells[index].className).toContain('text-right');
    }
  });

  it('renders a full-width table with the brand compare padding and hairlines', async () => {
    render(<AdminUsersPanel request={async () => jsonResponse(200, usersBody)} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const table = screen.getByTestId('admin-users-table');
    expect(table.className).toContain('w-full');
    expect(table.className).toContain('min-w-[52rem]');
    expect(table.className).toContain('border-[color:var(--line)]');
    expect(table.className).toContain('text-[0.94rem]');
    expect(table.parentElement?.className).toContain('overflow-x-auto');

    const headCells = Array.from(table.querySelectorAll('thead th'));
    expect(headCells).toHaveLength(10);
    const bodyCells = Array.from(table.querySelectorAll('tbody td'));
    expect(bodyCells).toHaveLength(20);
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
    const request: AjaxFetch = async (input) => {
      // The panel also fetches the error rings; only the users path counts.
      if (String(input) === '/api/admin/errors') {
        return jsonResponse(200, { errors: [] });
      }
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
    const request: AjaxFetch = async (input) => {
      if (String(input) === '/api/admin/errors') {
        return jsonResponse(200, { errors: [] });
      }
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

describe('AdminUsersPanel recent errors section', () => {
  it('renders recorded errors with message, time, scope, and source below the table', async () => {
    const requestedPaths: string[] = [];
    const request: AjaxFetch = async (input) => {
      const path = String(input);
      requestedPaths.push(path);
      if (path === '/api/admin/errors') {
        return jsonResponse(200, {
          errors: [
            {
              at: Date.UTC(2026, 2, 1, 10, 30),
              scope: 'flushProjectionGetRoomDoc',
              message: 'snapshot format 3 is not known',
              source: 'room',
              roomId: 'room-a',
            },
            {
              at: Date.UTC(2026, 2, 1, 9, 0),
              scope: 'billing:apply',
              message: 'apply failed',
              source: 'identity',
            },
          ],
        });
      }
      return jsonResponse(200, usersBody);
    };

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-errors')).toBeTruthy();
    });
    expect(requestedPaths).toContain('/api/admin/errors');

    const rows = screen.getAllByTestId('admin-error-row');
    expect(rows).toHaveLength(2);
    // Newest first, exactly as the bounded ring serves them.
    expect(rows[0].textContent).toContain('snapshot format 3 is not known');
    expect(rows[0].textContent).toContain('flushProjectionGetRoomDoc');
    expect(rows[0].textContent).toContain('room');
    expect(rows[0].textContent).toContain('room-a');
    expect(rows[1].textContent).toContain('apply failed');
    expect(rows[1].textContent).toContain('billing:apply');
    expect(rows[1].textContent).toContain('identity');

    const empty = screen.queryByTestId('admin-errors-empty');
    expect(empty).toBeNull();
    // The accounts table is untouched by the errors section.
    expect(screen.getByTestId('admin-users-table')).toBeTruthy();
  });

  it('shows an empty state when no errors are recorded', async () => {
    const request: AjaxFetch = async (input) =>
      String(input) === '/api/admin/errors'
        ? jsonResponse(200, { errors: [] })
        : jsonResponse(200, usersBody);

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-errors-empty')).toBeTruthy();
    });
    expect(screen.getByTestId('admin-errors-empty').textContent).toMatch(/no recent errors/i);
    expect(screen.queryByTestId('admin-errors-table')).toBeNull();
    expect(screen.getByTestId('admin-users-table')).toBeTruthy();
  });

  it('keeps the account table when the errors fetch fails', async () => {
    const request: AjaxFetch = async (input) =>
      String(input) === '/api/admin/errors'
        ? jsonResponse(500, { error: 'boom' })
        : jsonResponse(200, usersBody);

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.getByTestId('admin-users-total').textContent).toContain('2 accounts');
    expect(screen.queryByTestId('admin-errors')).toBeNull();
    expect(screen.queryByTestId('admin-load-error')).toBeNull();
  });

  it('ignores malformed error rows instead of rendering them', async () => {
    const request: AjaxFetch = async (input) =>
      String(input) === '/api/admin/errors'
        ? jsonResponse(200, {
            errors: [
              { at: 'not-a-number', scope: 'x', message: 'y', source: 'identity' },
              { at: 5, scope: '', message: 'y', source: 'identity' },
              { at: 6, scope: 'billing:apply', message: 'kept', source: 'identity' },
            ],
          })
        : jsonResponse(200, usersBody);

    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-errors')).toBeTruthy();
    });
    const rows = screen.getAllByTestId('admin-error-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('kept');
  });
});

describe('AdminUsersPanel search and load more', () => {
  function account(id: string, createdAt: number): Record<string, unknown> {
    return {
      accountId: id,
      state: 'active',
      provenance: 'access',
      displayName: null,
      organisation: null,
      plan: null,
      planStatus: null,
      rooms: 0,
      createdAt,
      updatedAt: createdAt,
    };
  }

  const pageOneBody = {
    accounts: [account('page_a2', 2000), account('page_a1', 1000)],
    total: 4,
    nextCursor: { createdAt: 1000, accountId: 'page_a1' },
  };
  const pageTwoBody = {
    accounts: [account('page_a4', 4000), account('page_a3', 3000)],
    total: 4,
    nextCursor: null,
  };
  const searchedBody = {
    accounts: [account('search_hit', 5000)],
    total: 1,
    nextCursor: null,
  };

  function panelRequest(usersPages: Record<string, unknown>): {
    request: AjaxFetch;
    userPaths: string[];
  } {
    const userPaths: string[] = [];
    const request: AjaxFetch = async (input) => {
      const path = String(input);
      if (path === '/api/admin/errors') {
        return jsonResponse(200, { errors: [] });
      }
      userPaths.push(path);
      for (const [needle, body] of Object.entries(usersPages)) {
        if (path.includes(needle)) return jsonResponse(200, body);
      }
      return jsonResponse(200, usersPages['*']);
    };
    return { request, userPaths };
  }

  it('hides Load more when the payload carries no next cursor', async () => {
    const { request } = panelRequest({ '*': { accounts: usersBody.accounts, total: 2, nextCursor: null } });
    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.queryByTestId('admin-users-load-more')).toBeNull();
  });

  it('appends the next page below the first via the cursor and retires the button', async () => {
    const { request } = panelRequest({
      'cursor=': pageTwoBody,
      '*': pageOneBody,
    });
    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    expect(screen.getAllByTestId(/^admin-user-/)).toHaveLength(2);
    expect(screen.getByTestId('admin-users-total').textContent).toContain('4 accounts');

    fireEvent.click(screen.getByTestId('admin-users-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('admin-user-page_a4')).toBeTruthy();
    });
    // Presentation order stays newest first across the appended page.
    const rows = screen.getAllByTestId(/^admin-user-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'admin-user-page_a4',
      'admin-user-page_a3',
      'admin-user-page_a2',
      'admin-user-page_a1',
    ]);
    expect(screen.getByTestId('admin-users-total').textContent).toContain('4 accounts');
    expect(screen.queryByTestId('admin-users-load-more')).toBeNull();
  });

  it('debounces the search input into one searched request and replaces the rows', async () => {
    const { request, userPaths } = panelRequest({
      'search=': searchedBody,
      '*': pageOneBody,
    });
    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const input = screen.getByTestId('admin-users-search');
    expect(input.tagName).toBe('INPUT');

    fireEvent.change(input, { target: { value: 'ada' } });
    // Debounced: nothing fires immediately after the keystroke.
    await act(async () => {
      await Promise.resolve();
    });
    expect(userPaths.filter((path) => path.includes('search='))).toHaveLength(0);

    await waitFor(() => {
      expect(userPaths.some((path) => path.includes('search=ada'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-user-search_hit')).toBeTruthy();
    });
    const searchFetches = userPaths.filter((path) => path.includes('search=ada'));
    expect(searchFetches).toHaveLength(1);
    expect(screen.getByTestId('admin-users-total').textContent).toContain('1 account');
  });

  it('returns to the unsearched list when the search input is cleared', async () => {
    const { request, userPaths } = panelRequest({
      'search=': searchedBody,
      '*': pageOneBody,
    });
    render(<AdminUsersPanel request={request} />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-users-table')).toBeTruthy();
    });
    const input = screen.getByTestId('admin-users-search');
    fireEvent.change(input, { target: { value: 'ada' } });
    await waitFor(() => {
      expect(userPaths.some((path) => path.includes('search=ada'))).toBe(true);
    });

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => {
      const unsearchedFetches = userPaths.filter(
        (path) => path === '/api/admin/users' || !path.includes('search='),
      );
      expect(unsearchedFetches.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-user-page_a2')).toBeTruthy();
    });
  });
});

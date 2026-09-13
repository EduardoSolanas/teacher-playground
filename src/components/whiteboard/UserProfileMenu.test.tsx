import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const assign = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: assign }),
}));

import { UserProfileMenu } from './UserProfileMenu';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number): Response {
  return new Response('nope', { status });
}

describe('UserProfileMenu', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', {
      assign,
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a profile menu in the header with name, sign out, and delete', async () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    await waitFor(() => {
      expect(screen.queryByTestId('referral-loading')).toBeNull();
    });
    expect(screen.getByTestId('whiteboard-profile-edit-name')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-logout-btn')).toBeTruthy();
    expect(screen.getByTestId('whiteboard-profile-delete')).toBeTruthy();
  });

  it('saves a new display name through PATCH /auth/account/profile', async () => {
    const onDisplayNameChange = vi.fn();
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/account/profile'
        ? jsonResponse({ displayName: 'Ms Ada' })
        : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={onDisplayNameChange} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-name-input'), {
      target: { value: 'Ms Ada' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-name-save'));

    await waitFor(() => {
      expect(onDisplayNameChange).toHaveBeenCalledWith('Ms Ada');
    });
    const saveCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/auth/account/profile');
    expect(saveCall).toBeTruthy();
    const init = saveCall?.[1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Ms Ada' });
  });

  it('falls back to the typed name when the save response carries none', async () => {
    const onDisplayNameChange = vi.fn();
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/account/profile' ? jsonResponse(null) : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={onDisplayNameChange} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-name-input'), {
      target: { value: 'Ms Ada' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-name-save'));

    await waitFor(() => {
      expect(onDisplayNameChange).toHaveBeenCalledWith('Ms Ada');
    });
  });

  it('falls back to the typed name when the save response carries another type', async () => {
    const onDisplayNameChange = vi.fn();
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/account/profile'
        ? jsonResponse({ displayName: 42 })
        : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={onDisplayNameChange} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-name-input'), {
      target: { value: 'Ms Ada' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-name-save'));

    await waitFor(() => {
      expect(onDisplayNameChange).toHaveBeenCalledWith('Ms Ada');
    });
  });

  it('reports a failed name save and keeps the form open', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/account/profile' ? errorResponse(500) : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-name-input'), {
      target: { value: 'Ms Ada' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-name-save'));

    await waitFor(() => {
      expect(screen.getByText('Could not save your name. Try again.')).toBeTruthy();
    });
    expect(screen.getByTestId('whiteboard-profile-name-input')).toBeTruthy();
  });

  it('ignores a blank rename submit', async () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-name-input'), {
      target: { value: '   ' },
    });
    fireEvent.submit(screen.getByTestId('whiteboard-profile-name-input').closest('form')!);

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((call) => String(call[0]) === '/auth/account/profile')).toHaveLength(0);
    });
    expect(screen.getByTestId('whiteboard-profile-name-input')).toBeTruthy();
  });

  it('moves focus into the menu and returns it to the trigger on Escape (UX-A5)', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    const trigger = screen.getByTestId('whiteboard-profile-btn');

    await user.click(trigger);
    const edit = screen.getByTestId('whiteboard-profile-edit-name');
    const logout = screen.getByTestId('whiteboard-logout-btn');
    const remove = screen.getByTestId('whiteboard-profile-delete');
    expect(document.activeElement).toBe(edit);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(logout);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(remove);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(logout);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(edit);

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('whiteboard-profile-edit-name')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the menu on Tab', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the menu open on a pointerdown inside it', () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.mouseDown(screen.getByRole('menu'));

    expect(screen.getByTestId('whiteboard-profile-edit-name')).toBeTruthy();
  });

  it('closes the menu on a pointerdown away from it', () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the menu open on keys that are not menu commands', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));
    await user.keyboard('a');

    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('does not walk menu items while a form is showing', () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-edit-name'));
    fireEvent.keyDown(screen.getByTestId('whiteboard-profile-name-input'), { key: 'ArrowDown' });

    expect(screen.getByTestId('whiteboard-profile-name-input')).toBeTruthy();
  });

  it('drops the menu role while a form is showing instead of the menu items', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.click(screen.getByTestId('whiteboard-profile-edit-name'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('whiteboard-profile-name-input')).toBeTruthy();
  });

  it('leaves focus rings to the global style on both of its inputs (UX-B12)', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));
    await user.click(screen.getByTestId('whiteboard-profile-edit-name'));
    const nameInput = screen.getByTestId('whiteboard-profile-name-input');
    expect(nameInput.className).not.toContain('outline-none');
    expect(nameInput.className).not.toContain('focus:border');

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(screen.getByTestId('whiteboard-profile-delete'));
    const confirmInput = screen.getByTestId('whiteboard-profile-delete-confirm-input');
    expect(confirmInput.className).not.toContain('outline-none');
    expect(confirmInput.className).not.toContain('focus:border');
  });

  it('uses the one in-room dropdown recipe and leaves 2xl to the canvas (UX-B6, UX-B14)', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));

    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('bg-slate-800');
    expect(menu.className).toContain('border-slate-700');
    expect(menu.className).toContain('rounded-xl');
    expect(menu.className).not.toContain('rounded-2xl');
    expect(menu.className).not.toContain('bg-white');
  });

  it('uses the app tracking-wider idiom rather than the marketing eyebrow (UX-B22)', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));

    const label = screen.getByText('Profile');
    expect(label.className).toContain('tracking-wider');
    expect(label.className).not.toContain('tracking-[0.14em]');
  });

  it('gives the profile control a tooltip when its name is not shown (UX-L17)', () => {
    const { unmount } = render(
      <UserProfileMenu
        displayName="Ada Lovelace"
        onDisplayNameChange={() => undefined}
        showDisplayName={false}
      />,
    );
    expect(screen.getByTestId('whiteboard-profile-btn').getAttribute('title'))
      .toBe('Ada Lovelace');

    unmount();
    render(
      <UserProfileMenu
        displayName={null}
        onDisplayNameChange={() => undefined}
        showDisplayName={false}
      />,
    );
    expect(screen.getByTestId('whiteboard-profile-btn').getAttribute('title')).toBe('Account');
  });

  it('labels the delete-confirmation input with the word it expects (UX-A18)', async () => {
    const user = userEvent.setup();
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    await user.click(screen.getByTestId('whiteboard-profile-btn'));
    await user.click(screen.getByTestId('whiteboard-profile-delete'));

    const input = screen.getByTestId('whiteboard-profile-delete-confirm-input');
    expect(screen.getByLabelText(/type delete to confirm/i)).toBe(input);
  });

  it('cancels the delete form without erasing anything', () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getByTestId('whiteboard-profile-delete')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-profile-delete-confirm-input')).toBeNull();
  });

  it('ignores a delete submit that has not typed DELETE', async () => {
    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);

    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-delete-confirm-input'), {
      target: { value: 'delete' },
    });
    fireEvent.submit(screen.getByTestId('whiteboard-profile-delete-confirm-input').closest('form')!);

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((call) => String(call[0]) === '/auth/account')).toHaveLength(0);
    });
    expect(screen.getByTestId('whiteboard-profile-delete-confirm-input')).toBeTruthy();
  });

  it('deletes the account after confirmation and leaves the whiteboard', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/account' ? jsonResponse({ ok: true }) : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-delete-confirm-input'), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete-confirm'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/');
    });
    const eraseCalls = fetchMock.mock.calls.filter((call) => String(call[0]) === '/auth/account');
    expect(eraseCalls).toHaveLength(1);
    expect((eraseCalls[0]?.[1] as RequestInit).method).toBe('DELETE');
  });

  it('re-confirms the session and retries a 403 delete', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === '/auth/account') {
        return calls.filter((entry) => entry === '/auth/account').length === 1
          ? errorResponse(403)
          : jsonResponse({ ok: true });
      }
      if (path === '/auth/session/confirm') return jsonResponse({ ok: true });
      return errorResponse(500);
    });

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-delete-confirm-input'), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete-confirm'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/');
    });
    expect(calls.filter((entry) => entry === '/auth/account')).toHaveLength(2);
    expect(calls).toContain('/auth/session/confirm');
  });

  it('reports a failed re-confirmation during delete', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === '/auth/account') return errorResponse(403);
      if (path === '/auth/session/confirm') return errorResponse(503);
      return errorResponse(500);
    });

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-delete-confirm-input'), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete-confirm'));

    await waitFor(() => {
      expect(screen.getByText('Could not delete this account. Try again.')).toBeTruthy();
    });
    expect(calls.filter((entry) => entry === '/auth/account')).toHaveLength(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('reports a failed retry after re-confirmation', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === '/auth/account') {
        return calls.filter((entry) => entry === '/auth/account').length === 1
          ? errorResponse(403)
          : errorResponse(500);
      }
      if (path === '/auth/session/confirm') return jsonResponse({ ok: true });
      return errorResponse(500);
    });

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete'));
    fireEvent.change(screen.getByTestId('whiteboard-profile-delete-confirm-input'), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(screen.getByTestId('whiteboard-profile-delete-confirm'));

    await waitFor(() => {
      expect(screen.getByText('Could not delete this account. Try again.')).toBeTruthy();
    });
    expect(calls.filter((entry) => entry === '/auth/account')).toHaveLength(2);
    expect(assign).not.toHaveBeenCalled();
  });

  it('signs out through the Access logout hand-off', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/auth/session/logout' ? jsonResponse({ ok: true }) : errorResponse(500),
    );

    render(<UserProfileMenu displayName="Ada Lovelace" onDisplayNameChange={() => undefined} />);
    fireEvent.click(screen.getByTestId('whiteboard-profile-btn'));
    fireEvent.click(screen.getByTestId('whiteboard-logout-btn'));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/auth/access/logout?redirect=%2F');
    });
    const logoutCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/auth/session/logout');
    expect((logoutCall?.[1] as RequestInit).method).toBe('POST');
  });
});

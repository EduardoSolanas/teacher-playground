import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ajaxFetch = vi.fn();
const assign = vi.fn();
const completeSignOut = vi.fn();

vi.mock('@/lib/http/ajaxFetch', () => ({
  ajaxFetch: (...args: unknown[]) => ajaxFetch(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: assign }),
}));

import { UserProfileMenu } from './UserProfileMenu';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('UserProfileMenu', () => {
  beforeEach(() => {
    ajaxFetch.mockReset();
    assign.mockReset();
    completeSignOut.mockReset();
    completeSignOut.mockImplementation(async ({ navigate }: { navigate: (path: string) => void }) => {
      navigate('/');
    });
    vi.stubGlobal('location', { assign });
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
    ajaxFetch.mockResolvedValue(jsonResponse({ displayName: 'Ms Ada' }));

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
    expect(ajaxFetch).toHaveBeenCalledWith('/auth/account/profile', expect.objectContaining({
      method: 'PATCH',
    }));
    const saveCall = ajaxFetch.mock.calls.find((call) => call[0] === '/auth/account/profile');
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ displayName: 'Ms Ada' });
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

  it('deletes the account after confirmation and leaves the whiteboard', async () => {
    ajaxFetch.mockResolvedValue(jsonResponse({ ok: true }));

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
    expect(ajaxFetch).toHaveBeenCalledWith('/auth/account', expect.objectContaining({
      method: 'DELETE',
    }));
  });
});

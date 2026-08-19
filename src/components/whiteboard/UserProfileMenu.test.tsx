import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
    expect(JSON.parse(String(ajaxFetch.mock.calls[0][1].body))).toEqual({ displayName: 'Ms Ada' });
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

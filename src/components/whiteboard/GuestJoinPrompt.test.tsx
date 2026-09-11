import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import GuestJoinPrompt from './GuestJoinPrompt';

const GUEST_PIN_ERROR = "That PIN didn't work. Check with your teacher and try again.";
const GUEST_TRANSPORT_ERROR =
  "We can't reach the class right now. Try again in a moment.";
const ROOM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fillAndSubmit(name: string, pin: string) {
  fireEvent.change(screen.getByTestId('guest-join-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('guest-join-pin'), { target: { value: pin } });
  fireEvent.submit(screen.getByTestId('guest-join-prompt').querySelector('form') ?? screen.getByTestId('guest-join-prompt'));
}

describe('GuestJoinPrompt', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a name field, a 6-digit PIN field, and Continue — never an email field', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    expect(screen.getByTestId('guest-join-prompt')).toBeTruthy();
    expect(screen.getByTestId('guest-join-name')).toBeTruthy();
    expect(screen.getByTestId('guest-join-pin')).toBeTruthy();
    expect(screen.getByTestId('guest-join-submit').textContent).toMatch(/continue/i);

    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(document.querySelector('input[name="email"]')).toBeNull();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it('uses an unmasked numeric PIN input', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    const pin = screen.getByTestId('guest-join-pin');
    expect(pin.getAttribute('type')).not.toBe('password');
    expect(pin.getAttribute('inputmode')).toBe('numeric');
    expect(pin.getAttribute('autocomplete')).toBe('off');
    expect(pin.getAttribute('maxlength')).toBe('6');
  });

  it('wraps the form in a dialog container rather than role="dialog" on the form (UX-A3)', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    const dialog = screen.getByRole('dialog', { name: /join class/i });
    expect(dialog.tagName).toBe('DIV');
    expect(dialog.querySelector('form')).toBeTruthy();
  });

  it('exposes a labelled modal dialog and moves focus onto the name field', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    const dialog = screen.getByRole('dialog', { name: /join class/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const heading = screen.getByRole('heading', { name: /join class/i });
    expect(heading.id).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);

    expect(document.activeElement).toBe(screen.getByTestId('guest-join-name'));
  });

  it('keeps Tab cycling inside the dialog', async () => {
    const user = userEvent.setup();
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    const nameInput = screen.getByTestId('guest-join-name');
    const pinInput = screen.getByTestId('guest-join-pin');
    const submitBtn = screen.getByTestId('guest-join-submit');
    await user.type(nameInput, 'Ada');
    await user.type(pinInput, '123456');

    nameInput.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(submitBtn);

    await user.tab();
    expect(document.activeElement).toBe(nameInput);

    await user.tab();
    expect(document.activeElement).toBe(pinInput);
  });

  it('pulls focus back into the dialog when Tab is pressed from outside it', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByTestId('guest-join-name'));
  });

  it('restores focus to the element focused before the gate opened', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open guest gate';
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('guest-join-name'));

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('keeps only digits in the PIN field', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    const pin = screen.getByTestId('guest-join-pin') as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '12ab34c5' } });
    expect(pin.value).toBe('12345');
  });

  it('trims and caps the display name before submit', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    const onJoined = vi.fn();
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={onJoined} />);

    const oversized = `  ${'A'.repeat(120)}  `;
    fillAndSubmit(oversized, '123456');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      roomId: ROOM_ID,
      pin: '123456',
      displayName: 'A'.repeat(100),
    });
  });

  it('does not POST when the name is empty or whitespace', () => {
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    fillAndSubmit('   ', '123456');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs /auth/guest and calls onJoined on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const onJoined = vi.fn();
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={onJoined} />);

    fillAndSubmit('  Ada  ', '654321');

    await waitFor(() => {
      expect(onJoined).toHaveBeenCalledWith('Ada');
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/auth/guest');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      roomId: ROOM_ID,
      pin: '654321',
      displayName: 'Ada',
    });
  });

  it.each([403, 404])('shows the generic PIN error for HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: 'nope' }));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} retryMs={180000} />);

    fillAndSubmit('Ada', '000000');

    await waitFor(() => {
      expect(screen.getByTestId('guest-join-error').textContent).toBe(GUEST_PIN_ERROR);
    });
  });

  it.each([429, 500])('shows a transport error without locking for HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: 'nope' }));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} retryMs={180000} />);

    fillAndSubmit('Ada', '000000');

    await waitFor(() => {
      expect(screen.getByTestId('guest-join-error').textContent).toBe(GUEST_TRANSPORT_ERROR);
    });
    expect(screen.queryByTestId('guest-join-retry-hint')).toBeNull();
    expect((screen.getByTestId('guest-join-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a transport error and does not lock when the request throws', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} retryMs={180000} />);

    fillAndSubmit('Ada', '000000');

    await waitFor(() => {
      expect(screen.getByTestId('guest-join-error').textContent).toBe(GUEST_TRANSPORT_ERROR);
    });
    expect(screen.queryByTestId('guest-join-retry-hint')).toBeNull();

    // An outage did not start the retry clock, so the child can try again now.
    fillAndSubmit('Ada', '000000');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('disables Continue and shows a retry hint after a rejected attempt', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} />);

    fillAndSubmit('Ada', '111111');

    await waitFor(() => {
      expect(screen.getByTestId('guest-join-error').textContent).toBe(GUEST_PIN_ERROR);
    });
    expect((screen.getByTestId('guest-join-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('guest-join-retry-hint')).toBeTruthy();
    expect(screen.getByTestId('guest-join-retry-hint').getAttribute('role')).toBe('status');
  });

  it('marks the fields invalid and describes them with the error text', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'nope' }));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} retryMs={180000} />);

    const nameInput = screen.getByTestId('guest-join-name');
    const pinInput = screen.getByTestId('guest-join-pin');
    expect(nameInput.getAttribute('aria-invalid')).toBe('false');
    expect(pinInput.getAttribute('aria-invalid')).toBe('false');

    fillAndSubmit('Ada', '000000');

    const errorEl = await screen.findByTestId('guest-join-error');
    expect(errorEl.id).toBeTruthy();
    for (const input of [nameInput, pinInput]) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe(errorEl.id);
    }
  });
});

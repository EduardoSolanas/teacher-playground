import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import GuestJoinPrompt from './GuestJoinPrompt';

const GUEST_PIN_ERROR = "That PIN didn't work. Check with your teacher and try again.";
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

  it.each([403, 404, 429, 500])('shows the same error for HTTP %s', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: 'nope' }));
    render(<GuestJoinPrompt roomId={ROOM_ID} onJoined={() => undefined} retryMs={180000} />);

    fillAndSubmit('Ada', '000000');

    await waitFor(() => {
      expect(screen.getByTestId('guest-join-error').textContent).toBe(GUEST_PIN_ERROR);
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
  });
});

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import WaitingRoom from './WaitingRoom';

const BASE_PROPS = {
  userName: 'Ada',
  waitingPosition: 2,
  onWait: () => undefined,
  onLeave: () => undefined,
};

describe('WaitingRoom', () => {
  it('keeps the queue status in a persistent live region', () => {
    render(<WaitingRoom {...BASE_PROPS} />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('2');
    expect(status.textContent).toContain('in line');
  });

  it('hides the decorative spinner from assistive technology', () => {
    const { container } = render(<WaitingRoom {...BASE_PROPS} />);

    expect(container.querySelector('.spinner-page')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says the queue is checked automatically', () => {
    render(<WaitingRoom {...BASE_PROPS} />);

    expect(screen.getByRole('status').textContent)
      .toContain('Checking automatically — last checked just now');
  });

  it('announces a manual check and its result in the live region', async () => {
    let resolveWait: (() => void) | undefined;
    const onWait = () => new Promise<void>((resolve) => { resolveWait = resolve; });
    render(<WaitingRoom {...BASE_PROPS} onWait={onWait} />);

    fireEvent.click(screen.getByRole('button', { name: /refresh status/i }));
    expect(screen.getByRole('status').textContent).toContain('Checking status…');

    await act(async () => {
      resolveWait?.();
    });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Checked just now');
    });
  });

  it('demotes manual refresh to a secondary, text-style action', () => {
    render(<WaitingRoom {...BASE_PROPS} />);

    const refresh = screen.getByRole('button', { name: /refresh status/i });
    expect(refresh.className).toContain('link-aside');
    expect(screen.getByTestId('whiteboard-leave-waiting-btn').className).toContain('btn-danger');
  });

  it('reports a full waiting list and shows no queue position', () => {
    render(<WaitingRoom {...BASE_PROPS} queueFull />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain(
      'The waiting list is full — ask your teacher to let someone in or try again shortly',
    );
    expect(status.textContent).not.toContain('number 2 in line');
    expect(document.querySelector('.queue-number')).toBeNull();
  });

  it('does not print a room code no UI can accept (UX-L14)', () => {
    /*
     * The screen printed the raw room id under "Room code", but nothing in the
     * product accepts a typed code: students arrive by link and a teacher's
     * list prints the link. The line invited a child to copy down an
     * identifier they could not use anywhere. The prop is gone with it.
     */
    const { container } = render(<WaitingRoom {...BASE_PROPS} />);

    expect(screen.queryByText('Room code')).toBeNull();
    expect(container.querySelector('.queue-code')).toBeNull();
  });

  it('tells a suspended student they were moved back to the waiting room', () => {
    render(<WaitingRoom {...BASE_PROPS} suspended />);

    expect(
      screen.getByRole('heading', { name: 'Your teacher moved you back to the waiting room' }),
    ).toBeTruthy();
    expect(screen.queryByText('Room is Full')).toBeNull();
  });
});

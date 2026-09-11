import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import UserNamePrompt from './UserNamePrompt';

describe('UserNamePrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('finds the input by its accessible name and submits with trimmed name', () => {
    const onJoin = vi.fn();

    render(<UserNamePrompt onJoin={onJoin} />);

    const input = screen.getByRole('textbox', { name: /your name/i });
    fireEvent.change(input, { target: { value: '  Alice  ' } });
    fireEvent.submit(input.closest('form')!);

    expect(onJoin).toHaveBeenCalledWith('Alice');
  });

  it('never prints the raw room id (UX-V9)', () => {
    /*
     * A thirty-two character hexadecimal string is noise to a child and names
     * a room only in a form no UI accepts. The room is already implicit in the
     * URL they arrived on; the line only has to say a teacher will let them in.
     * The prompt does not take a room id at all now.
     */
    const { container } = render(<UserNamePrompt onJoin={() => undefined} />);

    expect(container.textContent ?? '').not.toMatch(/[a-f0-9]{32}/i);
    expect(screen.queryByText(/room:/i)).toBeNull();
  });

  it('asks to join instead of promising entry', () => {
    render(<UserNamePrompt onJoin={() => undefined} />);

    expect(screen.getByRole('heading', { name: /ask to join/i })).toBeTruthy();
    expect(screen.getByText(/your teacher will let you in/i)).toBeTruthy();
    expect(screen.getByTestId('whiteboard-join-room-btn').textContent).toMatch(/ask to join/i);
  });

  it('wraps the form in a dialog container rather than role="dialog" on the form (UX-A3)', () => {
    render(<UserNamePrompt onJoin={() => undefined} />);

    const dialog = screen.getByRole('dialog', { name: /ask to join/i });
    expect(dialog.tagName).toBe('DIV');
    expect(dialog.querySelector('form')).toBeTruthy();
  });

  it('exposes a labelled modal dialog and moves focus onto the name field', () => {
    render(<UserNamePrompt onJoin={() => undefined} />);

    const dialog = screen.getByRole('dialog', { name: /ask to join/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const heading = screen.getByRole('heading', { name: /ask to join/i });
    expect(heading.id).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);

    expect(document.activeElement).toBe(screen.getByTestId('whiteboard-username-input'));
  });

  it('keeps Tab cycling inside the dialog', async () => {
    const user = userEvent.setup();
    render(<UserNamePrompt onJoin={() => undefined} />);

    const nameInput = screen.getByTestId('whiteboard-username-input');
    const joinBtn = screen.getByTestId('whiteboard-join-room-btn');
    await user.type(nameInput, 'Ada');

    nameInput.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(joinBtn);

    await user.tab();
    expect(document.activeElement).toBe(nameInput);
  });

  it('pulls focus back into the dialog when Tab is pressed from outside it', () => {
    render(<UserNamePrompt onJoin={() => undefined} />);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByTestId('whiteboard-username-input'));
  });

  it('restores focus to the element focused before the gate opened', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open join gate';
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <UserNamePrompt onJoin={() => undefined} />,
    );
    expect(document.activeElement).toBe(screen.getByTestId('whiteboard-username-input'));

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

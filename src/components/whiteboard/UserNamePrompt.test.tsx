import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import UserNamePrompt from './UserNamePrompt';

describe('UserNamePrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('finds the input by its accessible name and submits with trimmed name', () => {
    const onJoin = vi.fn();
    const roomId = 'test-room-id';

    render(<UserNamePrompt onJoin={onJoin} roomId={roomId} />);

    const input = screen.getByRole('textbox', { name: /your name/i });
    fireEvent.change(input, { target: { value: '  Alice  ' } });
    fireEvent.submit(input.closest('form')!);

    expect(onJoin).toHaveBeenCalledWith('Alice');
  });
});

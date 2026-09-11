import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import StartCallButton from './StartCallButton';

describe('StartCallButton', () => {
  it('joins the call only when pressed', () => {
    const onStart = vi.fn();
    render(<StartCallButton onStart={onStart} />);
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('av-start-call'));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('renders an inline start call button for the top nav', () => {
    render(<StartCallButton onStart={() => undefined} />);
    const button = screen.getByTestId('av-start-call');
    expect(button.className).toContain('inline-flex');
    expect(button.textContent).toContain('Start call');
  });

  it('hides the text label below the sm breakpoint', () => {
    render(<StartCallButton onStart={() => undefined} />);

    const labelSpan = screen.getByText('Start call');
    expect(labelSpan.className).toContain('hidden');
    expect(labelSpan.className).toContain('sm:inline');
  });

  it('is reachable by aria-label when text is hidden', () => {
    render(<StartCallButton onStart={() => undefined} />);

    const button = screen.getByRole('button', { name: 'Start call' });
    expect(button).toBeTruthy();
  });

  it('says rejoin when the room call is already running', () => {
    // A host who stepped out of a live call used to get "Start call" again,
    // which reads as a fresh call and broadcasts a fresh start. The call is
    // already there; going back into it is a rejoin.
    const onStart = vi.fn();
    render(<StartCallButton onStart={onStart} label="Rejoin call" />);

    const button = screen.getByTestId('av-start-call');
    expect(button.getAttribute('aria-label')).toBe('Rejoin call');
    expect(button.textContent).toContain('Rejoin call');

    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});


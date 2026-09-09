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
});


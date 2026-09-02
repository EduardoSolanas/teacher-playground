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

  it('sits where the call panel will appear', () => {
    // Pressing it should feel like opening the thing it turns into, not like
    // summoning a panel from somewhere else on the screen.
    render(<StartCallButton onStart={() => undefined} />);
    const button = screen.getByTestId('av-start-call');
    expect(button.className).toContain('sm:bottom-16');
    expect(button.className).toContain('sm:left-14');
  });

  it('sits below the Excalidraw toolbar on mobile', () => {
    render(<StartCallButton onStart={() => undefined} />);
    const button = screen.getByTestId('av-start-call');
    expect(button.className).toContain('top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)]');
  });
});


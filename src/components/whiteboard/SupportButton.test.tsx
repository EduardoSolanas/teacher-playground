import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import SupportButton, { SUPPORT_EMAIL } from './SupportButton';

describe('SupportButton', () => {
  it('is a question mark until it is pressed', () => {
    render(<SupportButton />);
    expect(screen.getByTestId('whiteboard-support-btn')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('offers a way to write to somebody', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));

    const link = screen.getByTestId('whiteboard-support-email') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`);
    expect(link.textContent).toBe(SUPPORT_EMAIL);
  });

  it('closes again', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    expect(screen.getByTestId('whiteboard-support-panel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('whiteboard-support-close'));
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('closes when the room is clicked away from', () => {
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('whiteboard-support-panel')).toBeNull();
  });

  it('says who it is for, not what the keys do', () => {
    // It replaced a shortcuts sheet. Somebody pressing "?" mid-lesson wants a
    // person, and this is the only route to one the room offers.
    render(<SupportButton />);
    fireEvent.click(screen.getByTestId('whiteboard-support-btn'));
    expect(screen.getByTestId('whiteboard-support-panel').textContent).toMatch(/help|support/i);
  });
});

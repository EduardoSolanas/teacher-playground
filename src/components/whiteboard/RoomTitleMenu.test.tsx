import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import RoomTitleMenu from './RoomTitleMenu';
import { UNNAMED_ROOM_TITLE } from './TeacherRoomList';

function make(overrides: Partial<Parameters<typeof RoomTitleMenu>[0]> = {}) {
  return {
    name: 'Year 4 Maths',
    canManage: true,
    onRename: vi.fn(),
    onSaveAs: vi.fn(),
    onOpenLibrary: vi.fn(),
    ...overrides,
  };
}

describe('RoomTitleMenu', () => {
  it('says what the room is called', () => {
    render(<RoomTitleMenu {...make()} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
  });

  it('falls back to the same words the room list uses', () => {
    render(<RoomTitleMenu {...make({ name: null })} />);
    expect(screen.getByTestId('room-name').textContent).toContain(UNNAMED_ROOM_TITLE);
  });

  it('looks like a menu before it is opened', () => {
    // A bare title tells nobody it can be pressed. The chevron and the
    // expanded state are what say so, to a mouse and to a screen reader.
    render(<RoomTitleMenu {...make()} />);
    const trigger = screen.getByTestId('room-title-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('room-title-chevron')).toBeTruthy();
  });

  it('offers save, rename and the library', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-title-trigger').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('room-menu-save')).toBeTruthy();
    expect(screen.getByTestId('room-menu-rename')).toBeTruthy();
    expect(screen.getByTestId('room-menu-library')).toBeTruthy();
  });

  it('says what the library item does, which is more than adding to it', () => {
    // It opens Excalidraw's library panel: what is in there, what has been
    // installed, and removing any of it. "Add to library" named a third of it.
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-menu-library').textContent).toBe('Manage library');
  });

  it('saves and opens the library through the caller', () => {
    const props = make();
    render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-save'));
    expect(props.onSaveAs).toHaveBeenCalledTimes(1);
    // The menu closes behind a choice, or it sits over the board.
    expect(screen.queryByTestId('room-menu-save')).toBeNull();

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-library'));
    expect(props.onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it('renames in place, starting from the name it already has', () => {
    const props = make();
    const { rerender } = render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));
    const input = screen.getByTestId('room-name-input') as HTMLInputElement;
    expect(input.value).toBe('Year 4 Maths');

    fireEvent.change(input, { target: { value: 'Year 5 Maths' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith('Year 5 Maths');

    rerender(<RoomTitleMenu {...make({ name: 'Year 5 Maths' })} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 5 Maths');
  });

  it('abandons a rename on Escape and refuses a blank one', () => {
    /*
     * roomSettingsSchema takes a non-empty string or nothing at all, so a
     * blank save would 400 and be swallowed -- an edit that looked committed
     * and changed nothing.
     */
    const props = make();
    render(<RoomTitleMenu {...props} />);

    fireEvent.click(screen.getByTestId('room-title-trigger'));
    fireEvent.click(screen.getByTestId('room-menu-rename'));
    fireEvent.change(screen.getByTestId('room-name-input'), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByTestId('room-name-input'), { key: 'Enter' });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name-input')).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId('room-name-input'), { key: 'Escape' });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
  });

  it('shows the name without a menu to anybody who may not manage the room', () => {
    // Every item behind it is the owner's: renaming is owner-only on the
    // server, and so is taking a copy of a child's work away.
    render(<RoomTitleMenu {...make({ canManage: false })} />);
    expect(screen.getByTestId('room-name').textContent).toContain('Year 4 Maths');
    expect(screen.queryByTestId('room-title-trigger')).toBeNull();
    expect(screen.queryByTestId('room-title-chevron')).toBeNull();
  });

  it('closes when the room is clicked away from', () => {
    render(<RoomTitleMenu {...make()} />);
    fireEvent.click(screen.getByTestId('room-title-trigger'));
    expect(screen.getByTestId('room-menu-save')).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('room-menu-save')).toBeNull();
  });
});

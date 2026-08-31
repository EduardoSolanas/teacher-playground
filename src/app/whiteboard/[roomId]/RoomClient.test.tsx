import { describe, expect, it } from 'vitest';

import { ROOM_CANVAS_CLASS, roomCanvasTopClass } from './RoomClient';

describe('room canvas responsive top offset', () => {
  it('keeps the guest canvas at the viewport top while retaining the desktop nav offset', () => {
    expect(roomCanvasTopClass(true)).toBe('top-0 sm:top-12');
    expect(roomCanvasTopClass(false)).toBe('top-[calc(3rem+env(safe-area-inset-top))] sm:top-12');
  });
});

describe('room canvas width', () => {
  it('spans the window rather than making room for the furniture', () => {
    /*
     * The rail and the roster are both `fixed` and float over the board, so
     * narrowing the board for them cost a teacher a strip of drawing surface
     * down each side that nothing was ever painted into -- and the right-hand
     * strip appeared and vanished as the roster was collapsed, resizing the
     * canvas under a lesson in progress.
     */
    expect(ROOM_CANVAS_CLASS).toContain('inset-x-0');
    expect(ROOM_CANVAS_CLASS).not.toContain('sm:left-14');
    expect(ROOM_CANVAS_CLASS).not.toContain('100vw');
  });
});

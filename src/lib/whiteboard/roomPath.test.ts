import { describe, expect, it, vi } from 'vitest';
import {
  navigateToWhiteboardRoom,
  roomIdFromWhiteboardPath,
} from './roomPath';

describe('roomIdFromWhiteboardPath', () => {
  it('reads the real room id from the address bar', () => {
    expect(roomIdFromWhiteboardPath('/whiteboard/abc123def')).toBe('abc123def');
  });

  it('rejects the static-export placeholder and an interpolated undefined id', () => {
    expect(roomIdFromWhiteboardPath('/whiteboard/_room')).toBeNull();
    expect(roomIdFromWhiteboardPath('/whiteboard/undefined')).toBeNull();
    expect(roomIdFromWhiteboardPath('/whiteboard')).toBeNull();
  });
});

describe('navigateToWhiteboardRoom', () => {
  it('assigns the room URL so the address bar keeps the real id', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });

    navigateToWhiteboardRoom('room-alpha');

    expect(assign).toHaveBeenCalledWith('/whiteboard/room-alpha');
    vi.unstubAllGlobals();
  });
});

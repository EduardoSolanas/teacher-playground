import { describe, it, expect } from 'vitest';
import { MAX_ROOM_FILE_BYTES_TOTAL } from '../lib/whiteboard/boardFileRoutes';
import { getFileBytesTotal, addFileBytes, setFileBytes } from '../lib/whiteboard/roomSchema';

describe('Room file quota constants and functions', () => {
  it('exports correct 250 MB aggregate quota constant', () => {
    expect(MAX_ROOM_FILE_BYTES_TOTAL).toBe(250 * 1024 * 1024);
  });

  it('getFileBytesTotal, addFileBytes, and setFileBytes are exported functions', () => {
    expect(typeof getFileBytesTotal).toBe('function');
    expect(typeof addFileBytes).toBe('function');
    expect(typeof setFileBytes).toBe('function');
  });
});

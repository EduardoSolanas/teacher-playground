import { describe, expect, it } from 'vitest';
import {
  ORPHAN_GRACE_MS,
  fileIdFromKey,
  orphanKeys,
  referencedFileIds,
} from './orphanFiles';

const NOW = 1_800_000_000_000;
const old = (ms: number) => new Date(NOW - ms);

function stored(fileId: string, ageMs: number, roomId = 'room-1') {
  return { key: `rooms/${roomId}/files/${fileId}`, uploaded: old(ageMs) };
}

describe('referencedFileIds', () => {
  it('collects the files the board mentions', () => {
    const referenced = referencedFileIds([
      { id: 'a', type: 'image', fileId: 'file-1' },
      { id: 'b', type: 'freedraw' },
      { id: 'c', type: 'image', fileId: 'file-2' },
    ]);
    expect([...referenced].sort()).toEqual(['file-1', 'file-2']);
  });

  it('still counts a file an erased element points at', () => {
    // Excalidraw erases by flagging, and undo brings the element back wanting
    // its image. Collecting on the flag would make undo restore a broken one.
    const referenced = referencedFileIds([
      { id: 'a', type: 'image', fileId: 'file-1', isDeleted: true },
    ]);
    expect(referenced.has('file-1')).toBe(true);
  });

  it('ignores anything that is not an element with a file', () => {
    expect(referencedFileIds([null, undefined, 42, 'x', {}, { fileId: '' }]).size).toBe(0);
  });
});

describe('orphanKeys', () => {
  it('collects a file nothing references once it is past the grace period', () => {
    const keys = orphanKeys({
      files: [stored('gone', ORPHAN_GRACE_MS + 1_000)],
      referenced: new Set(),
      now: NOW,
    });
    expect(keys).toEqual(['rooms/room-1/files/gone']);
  });

  it('keeps a file the board still references, however old', () => {
    const keys = orphanKeys({
      files: [stored('kept', 365 * 24 * 60 * 60 * 1000)],
      referenced: new Set(['kept']),
      now: NOW,
    });
    expect(keys).toEqual([]);
  });

  it('keeps a freshly uploaded file that nothing references yet', () => {
    /*
     * The upload lands before the element that references it does. Inside that
     * window a live file is indistinguishable from an orphan, and deleting it
     * would break the image for the peer who had just added it.
     */
    const keys = orphanKeys({
      files: [stored('just-uploaded', 1_000)],
      referenced: new Set(),
      now: NOW,
    });
    expect(keys).toEqual([]);
  });

  it('leaves keys outside our own layout alone', () => {
    // The answer here is handed straight to a delete, so an unrecognised key
    // is skipped rather than guessed at.
    const keys = orphanKeys({
      files: [{ key: 'something/else.png', uploaded: old(ORPHAN_GRACE_MS * 10) }],
      referenced: new Set(),
      now: NOW,
    });
    expect(keys).toEqual([]);
  });

  it('collects several orphans and keeps the referenced ones alongside them', () => {
    const keys = orphanKeys({
      files: [
        stored('orphan-1', ORPHAN_GRACE_MS * 2),
        stored('live-1', ORPHAN_GRACE_MS * 2),
        stored('orphan-2', ORPHAN_GRACE_MS * 3),
      ],
      referenced: new Set(['live-1']),
      now: NOW,
    });
    expect(keys.sort()).toEqual([
      'rooms/room-1/files/orphan-1',
      'rooms/room-1/files/orphan-2',
    ]);
  });
});

describe('fileIdFromKey', () => {
  it('reads the id out of a board file key', () => {
    expect(fileIdFromKey('rooms/abc/files/file-9')).toBe('file-9');
  });

  it('refuses keys that are not board files', () => {
    expect(fileIdFromKey('rooms/abc/files/nested/file-9')).toBeNull();
    expect(fileIdFromKey('rooms/abc/file-9')).toBeNull();
    expect(fileIdFromKey('')).toBeNull();
  });
});

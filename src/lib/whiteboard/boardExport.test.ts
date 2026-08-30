import { describe, expect, it } from 'vitest';

import {
  boardFileName,
  buildExcalidrawContainer,
  exportableElements,
  referencedFileIds,
} from './boardExport';

const image = (id: string, fileId: string, isDeleted = false) => ({
  id, type: 'image', fileId, isDeleted, x: 0, y: 0, width: 100, height: 80,
});

/** An image element left as the placeholder it is inserted as. */
const placeholder = (id: string, fileId: string) => ({
  id, type: 'image', fileId, isDeleted: false, x: 0, y: 0, width: 0, height: 0,
});

const file = (id: string) => ({
  id, dataURL: `data:image/webp;base64,${id}`, mimeType: 'image/webp', created: 1,
});

describe('referencedFileIds', () => {
  it('lists each referenced image once', () => {
    // The same photograph on four elements is one file in the export.
    expect(referencedFileIds([
      image('a', 'photo-1'),
      image('b', 'photo-1'),
      image('c', 'photo-2'),
    ])).toEqual(['photo-1', 'photo-2']);
  });

  it('ignores images that were erased', () => {
    // The file is a copy of what is on the board, not of everything that has
    // ever been on it: carrying the bytes of an erased photograph would make
    // the export larger than the board and would restore something deleted.
    expect(referencedFileIds([image('a', 'photo-1', true)])).toEqual([]);
  });

  it('ignores an image that never got a size', () => {
    /*
     * Excalidraw inserts an image as a nought-by-nought placeholder and fills
     * the size in when the bitmap resolves. One that never resolved is on the
     * board only in the sense that it is in the array: it draws nothing, and
     * cannot be selected or erased, so it would sit in every export a teacher
     * ever took of that room, carrying its bytes with it.
     */
    expect(referencedFileIds([placeholder('a', 'photo-1')])).toEqual([]);
    expect(referencedFileIds([
      image('a', 'photo-1'),
      placeholder('b', 'photo-2'),
    ])).toEqual(['photo-1']);
  });

  it('survives elements that carry no file at all', () => {
    expect(referencedFileIds([
      { id: 'x', type: 'freedraw' },
      null,
      undefined,
      { id: 'y', type: 'image', fileId: '' },
    ])).toEqual([]);
  });
});

describe('exportableElements', () => {
  it('keeps what is on the board and drops what was erased', () => {
    const kept = exportableElements([
      { id: 'a', isDeleted: false },
      { id: 'b', isDeleted: true },
      { id: 'c' },
    ]);
    expect(kept.map((element) => element.id)).toEqual(['a', 'c']);
  });

  it('drops an image that never got a size', () => {
    const kept = exportableElements([image('a', 'photo-1'), placeholder('b', 'photo-2')]);
    expect(kept.map((element) => element.id)).toEqual(['a']);
  });

  it('keeps a shape that is flat in one direction', () => {
    // A line drawn straight across is nought high and is on the board; only an
    // image with no area is the placeholder case.
    const kept = exportableElements([
      { id: 'a', type: 'line', width: 200, height: 0 },
      { id: 'b', type: 'freedraw', width: 0, height: 140 },
    ]);
    expect(kept.map((element) => element.id)).toEqual(['a', 'b']);
  });

  it('keeps an image whose size it cannot read', () => {
    // Nothing is guessed at here: an element that does not say how big it is
    // is left in the export rather than silently dropped from a backup.
    const kept = exportableElements([{ id: 'a', type: 'image', fileId: 'photo-1' }]);
    expect(kept.map((element) => element.id)).toEqual(['a']);
  });
});

describe('buildExcalidrawContainer', () => {
  it('writes the shape other Excalidraws read', () => {
    const container = buildExcalidrawContainer([{ id: 'a' }], [], 'teacher-playground');
    expect(container.type).toBe('excalidraw');
    expect(container.version).toBe(2);
    expect(container.source).toBe('teacher-playground');
    expect(container.elements).toEqual([{ id: 'a' }]);
  });

  it('packs only the images the kept elements still refer to', () => {
    /*
     * The bytes are the bulk of the file, so carrying one that nothing points
     * at is the difference between a board that exports in a moment and one
     * that carries a term of erased photographs with it.
     */
    const container = buildExcalidrawContainer(
      [image('a', 'photo-1'), image('b', 'photo-2', true), placeholder('c', 'photo-4')],
      [file('photo-1'), file('photo-2'), file('photo-3'), file('photo-4')],
      'teacher-playground',
    );
    expect(Object.keys(container.files)).toEqual(['photo-1']);
    expect(container.elements.map((element) => element.id)).toEqual(['a']);
  });
});

describe('boardFileName', () => {
  const when = Date.UTC(2026, 7, 30, 9, 45);

  it('names the file after the room and the day', () => {
    expect(boardFileName('15acb14c', 'Maths Tuesday', 'excalidraw', when))
      .toBe('Maths Tuesday 2026-08-30.excalidraw');
  });

  it('falls back to the room when nobody named it', () => {
    // A folder of files named after thirty-two character identifiers is a
    // folder nobody opens, but an unnamed room still has to be findable.
    expect(boardFileName('15acb14cdd981d5dfe', null, 'png', when))
      .toBe('room-15acb14c 2026-08-30.png');
    expect(boardFileName('15acb14cdd981d5dfe', '   ', 'png', when))
      .toBe('room-15acb14c 2026-08-30.png');
  });

  it('refuses to let a room name become a path', () => {
    /*
     * A room name is free text a teacher typed and it reaches a file system
     * here. A slash in it would be a directory, a leading dot would be a
     * hidden file, and '..' would be somewhere else entirely.
     */
    expect(boardFileName('abc12345', '../../etc/passwd', 'excalidraw', when))
      .toBe('etc-passwd 2026-08-30.excalidraw');
    expect(boardFileName('abc12345', '.hidden', 'excalidraw', when))
      .toBe('hidden 2026-08-30.excalidraw');
    expect(boardFileName('abc12345', 'a/b\\c:d', 'excalidraw', when))
      .toBe('a-b-c-d 2026-08-30.excalidraw');
  });

  it('keeps a very long name to something a file system will take', () => {
    const name = boardFileName('abc12345', 'x'.repeat(300), 'excalidraw', when);
    expect(name.length).toBeLessThan(90);
  });
});

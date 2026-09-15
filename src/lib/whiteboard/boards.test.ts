import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { renderHook, act } from '@testing-library/react';
import { useBoardList, mainBoard } from './boards';

/*
 * Every test below hoists its document out of the render callback on purpose.
 * `useBoardList` observes the document identity, so creating the doc inside
 * the callback hands the hook a new document on every render and the effect
 * never settles — the room always passes a stable doc, and so must the tests.
 */
describe('useBoardList', () => {
  it('always offers the main board first, even on an empty document', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useBoardList(doc));

    expect(result.current.boards).toEqual([mainBoard()]);
  });

  it('lists boards the document defines, ordered', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap('boardsMeta').set('board-b', { name: 'Geometry', order: 2 });
      doc.getMap('boardsMeta').set('board-a', { name: 'Algebra', order: 1 });
    });

    const { result } = renderHook(() => useBoardList(doc));

    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-a', 'board-b']);
    expect(result.current.boards[1].name).toBe('Algebra');
  });

  it('follows boards another peer added, live', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useBoardList(doc));
    expect(result.current.boards).toHaveLength(1);

    act(() => {
      doc.transact(() => {
        doc.getMap('boardsMeta').set('board-x', { name: 'Board 2', order: 1 });
      });
    });

    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-x']);
  });

  it('addBoard writes the definition into the document and returns the new id', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useBoardList(doc));

    let id = '';
    act(() => {
      id = result.current.addBoard();
    });

    expect(id).toMatch(/^board-[0-9a-f]{12}$/);
    const stored = doc.getMap('boardsMeta').get(id) as { name?: string; order?: number };
    expect(stored.name).toBe('Board 2');
    expect(stored.order).toBe(1);
    expect(result.current.boards.map((board) => board.id)).toEqual(['main', id]);
  });

  it('numbers the new board one past the highest order, not past the count', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-old', { name: 'Old', order: 41 });
    const { result } = renderHook(() => useBoardList(doc));

    let id = '';
    act(() => {
      id = result.current.addBoard();
    });

    const stored = doc.getMap('boardsMeta').get(id) as { name?: string; order?: number };
    expect(stored.name).toBe('Board 3');
    expect(stored.order).toBe(42);
  });

  it('adds while below the guard boundary', () => {
    const doc = new Y.Doc();
    const meta = doc.getMap('boardsMeta');
    // 48 seeded + main = 49: one more fits.
    for (let i = 0; i < 48; i += 1) {
      meta.set(`board-${i}`, { name: `Board ${i}`, order: i });
    }
    const { result } = renderHook(() => useBoardList(doc));

    let id = '';
    act(() => {
      id = result.current.addBoard();
    });
    expect(id).toMatch(/^board-/);
    expect(meta.size).toBe(49);
  });

  it('refuses exactly at the guard boundary', () => {
    const doc = new Y.Doc();
    const meta = doc.getMap('boardsMeta');
    // 49 seeded + main = 50: the cap is reached, nothing is written and the
    // caller keeps the main board. `>=` refuses here; `>` would let one
    // more through.
    for (let i = 0; i < 49; i += 1) {
      meta.set(`board-${i}`, { name: `Board ${i}`, order: i });
    }
    const { result } = renderHook(() => useBoardList(doc));

    let id = '';
    act(() => {
      id = result.current.addBoard();
    });
    expect(id).toBe('main');
    expect(meta.size).toBe(49);
  });

  it('renameBoard writes the new name and never renames the main board', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-1', { name: 'Board 2', order: 1 });
    const { result } = renderHook(() => useBoardList(doc));

    act(() => {
      result.current.renameBoard('board-1', '  Algebra  ');
      result.current.renameBoard('main', 'Not Allowed');
    });

    expect((doc.getMap('boardsMeta').get('board-1') as { name?: string; order?: number })).toEqual({
      name: 'Algebra',
      order: 1,
    });
    expect(doc.getMap('boardsMeta').get('main')).toBeUndefined();
  });

  it('refuses a blank rename rather than wiping the name', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-1', { name: 'Algebra', order: 1 });
    const { result } = renderHook(() => useBoardList(doc));

    act(() => {
      result.current.renameBoard('board-1', '   ');
    });

    expect((doc.getMap('boardsMeta').get('board-1') as { name?: string }).name).toBe('Algebra');
  });

  it('keeps the room whole when there is no document yet', () => {
    const { result } = renderHook(() => useBoardList(null));

    expect(result.current.boards).toEqual([mainBoard()]);
    expect(result.current.addBoard()).toBe('main');
  });

  it('copes with a malformed definition instead of crashing the tabs', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-bad', 'not an object');
    doc.getMap('boardsMeta').set('board-null', null);
    doc.getMap('boardsMeta').set('board-nameless', { order: 1 });

    const { result } = renderHook(() => useBoardList(doc));

    // A definition that is not an object gets no tab; one that merely lost
    // its name still draws, under a fallback.
    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-nameless']);
    expect(result.current.boards[1].name).toBe('Board 2');
  });

  it('falls back for blank names and non-finite orders', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap('boardsMeta').set('board-blank', { name: '   ', order: 1 });
      doc.getMap('boardsMeta').set('board-nan', { name: 'Kept', order: Number.NaN });
    });

    const { result } = renderHook(() => useBoardList(doc));

    expect(result.current.boards.find((board) => board.id === 'board-blank')?.name).toBe('Board 2');
    expect(result.current.boards.find((board) => board.id === 'board-nan')?.order).toBe(1);
  });

  it('trims a padded name rather than showing it raw', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-pad', { name: '  ', order: 1 });

    const { result } = renderHook(() => useBoardList(doc));

    // Whitespace-only is no name at all: the tab falls back rather than
    // rendering a blank entry.
    expect(result.current.boards.find((board) => board.id === 'board-pad')?.name).toBe('Board 2');
  });

  it('sorts by order first, breaking ties by id', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      // Ids sort opposite to orders on purpose: sorting by id alone would
      // put board-a first and break this.
      doc.getMap('boardsMeta').set('board-z', { name: 'First', order: 1 });
      doc.getMap('boardsMeta').set('board-a', { name: 'Second', order: 2 });
      doc.getMap('boardsMeta').set('board-m', { name: 'Tied', order: 2 });
    });

    const { result } = renderHook(() => useBoardList(doc));

    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-z', 'board-a', 'board-m']);
  });

  it('ignores a stored main definition: the canonical main board always leads', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap('boardsMeta').set('main', { name: 'Hacked', order: 99 });
      doc.getMap('boardsMeta').set('board-a', { name: 'Algebra', order: 1 });
    });

    const { result } = renderHook(() => useBoardList(doc));

    // A stored def for 'main' is dropped outright: the canonical main board
    // leads and no duplicate tab appears.
    expect(result.current.boards).toEqual([mainBoard(), { id: 'board-a', name: 'Algebra', order: 1 }]);
  });

  it('writes with the local origin so the editor never echoes them back', () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: { origin: unknown }) => {
      origins.push(transaction.origin);
    });
    const { result } = renderHook(() => useBoardList(doc));

    act(() => {
      result.current.addBoard();
    });
    act(() => {
      result.current.renameBoard(result.current.boards[1]?.id ?? 'main', 'Renamed');
    });

    /*
     * ExcalidrawWrapper's shared-map observer re-publishes every transaction
     * whose origin is not exactly 'local'. A board write under any other
     * origin would bounce straight back into the scene as if a peer sent it.
     */
    expect(origins).toEqual(['local', 'local']);
  });

  it('rebinds when the room hands the hook a new document', () => {
    const doc1 = new Y.Doc();
    doc1.getMap('boardsMeta').set('board-x', { name: 'First', order: 1 });
    const doc2 = new Y.Doc();
    doc2.getMap('boardsMeta').set('board-y', { name: 'Second', order: 1 });

    const { result, rerender } = renderHook(({ doc }) => useBoardList(doc), { initialProps: { doc: doc1 } });
    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-x']);

    rerender({ doc: doc2 });

    // The effect re-subscribes to the new document and refreshes the list.
    expect(result.current.boards.map((board) => board.id)).toEqual(['main', 'board-y']);

    let id = '';
    act(() => {
      id = result.current.addBoard();
    });
    expect(doc2.getMap('boardsMeta').get(id)).toBeTruthy();
    expect(doc1.getMap('boardsMeta').size).toBe(1);

    act(() => {
      result.current.renameBoard('board-y', 'Renamed');
    });
    expect((doc2.getMap('boardsMeta').get('board-y') as { name?: string }).name).toBe('Renamed');
  });
});

describe('mainBoard', () => {
  it('is the board unstamped elements belong to', () => {
    expect(mainBoard().id).toBe('main');
  });

  it('is stable per call', () => {
    expect(mainBoard()).toEqual(mainBoard());
  });

  it('names the main board Board 1', () => {
    expect(mainBoard().name).toBe('Board 1');
  });
});

describe('guard cooperation', () => {
  it('writes stay inside the shape the server guard accepts', () => {
    const doc = new Y.Doc();
    const { result } = renderHook(() => useBoardList(doc));
    act(() => {
      result.current.addBoard();
    });

    const stored = doc.getMap('boardsMeta').get(result.current.boards[1].id);
    expect(stored).toEqual(expect.objectContaining({ name: expect.any(String), order: expect.any(Number) }));
  });
});

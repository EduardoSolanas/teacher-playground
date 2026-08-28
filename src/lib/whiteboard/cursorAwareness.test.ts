import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import {
  clearCursor,
  publishCursor,
  readCursorStates,
  readCursorUsers,
  readLocalCursor,
  readRemoteCursors,
} from './cursorAwareness';

/** Two real Awareness instances wired together the way the socket wires peers. */
function connectedPair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  const relay = (from: Awareness, to: Awareness) => {
    from.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed);
      applyAwarenessUpdate(to, encodeAwarenessUpdate(from, changed), 'remote');
    });
  };
  relay(a, b);
  relay(b, a);
  return { a, b };
}

const ADA = { peerId: 'peer-ada', userName: 'Ada', color: '#3498db', x: 10, y: 20 };
const GRACE = { peerId: 'peer-grace', userName: 'Grace', color: '#e74c3c', x: 30, y: 40 };

describe('cursorAwareness', () => {
  it('carries a cursor to the other peer', () => {
    const { a, b } = connectedPair();
    publishCursor(a, ADA);
    expect(readRemoteCursors(b)).toEqual([ADA]);
  });

  it('leaves the document untouched', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    for (let i = 0; i < 5_000; i++) {
      publishCursor(awareness, { ...ADA, x: i, y: i });
    }
    // The whole point: five thousand cursor moves add nothing to what is stored.
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBe(before);
  });

  it('excludes this peer from the cursors it draws but not from the roster', () => {
    const { a, b } = connectedPair();
    publishCursor(a, ADA);
    publishCursor(b, GRACE);
    expect(readRemoteCursors(a)).toEqual([GRACE]);
    expect(readCursorStates(a).map((cursor) => cursor.peerId).sort())
      .toEqual(['peer-ada', 'peer-grace']);
    expect(readCursorUsers(a)).toContainEqual({
      peerId: 'peer-ada', userName: 'Ada', color: '#3498db', isHost: false,
    });
  });

  it('drops a withdrawn cursor from the other peer', () => {
    const { a, b } = connectedPair();
    publishCursor(a, ADA);
    expect(readRemoteCursors(b)).toHaveLength(1);
    clearCursor(a);
    expect(readRemoteCursors(b)).toEqual([]);
  });

  it('reads back this peer\'s own last position', () => {
    const awareness = new Awareness(new Y.Doc());
    expect(readLocalCursor(awareness)).toBeNull();
    publishCursor(awareness, ADA);
    expect(readLocalCursor(awareness)).toEqual(ADA);
  });

  it('ignores announcements that are not cursors', () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalStateField('cursor', { nonsense: true });
    expect(readRemoteCursors(awareness)).toEqual([]);
    expect(readLocalCursor(awareness)).toBeNull();
  });

  it('is inert without a provider, as on the server', () => {
    expect(readRemoteCursors(null)).toEqual([]);
    expect(readCursorStates(undefined)).toEqual([]);
    expect(readLocalCursor(null)).toBeNull();
    expect(() => publishCursor(null, ADA)).not.toThrow();
    expect(() => clearCursor(undefined)).not.toThrow();
  });
});

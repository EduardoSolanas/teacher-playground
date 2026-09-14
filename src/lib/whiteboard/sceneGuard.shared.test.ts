import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sanitizeSharedDoc } from './sceneGuard';

describe('sanitizeSharedDoc', () => {
  it('prunes a flooded fileReady map down to valid entries and reports what it did', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('fileReady');
    for (let i = 0; i < 50; i += 1) map.set(`flood-${i}`, 'x'.repeat(200));
    map.set('real-file-id', Date.now());

    const result = sanitizeSharedDoc(doc);

    expect(doc.getMap('fileReady').size).toBe(1);
    expect(doc.getMap('fileReady').get('real-file-id')).toBeTypeOf('number');
    expect(result.changed).toBe(true);
    expect(result.prunedEntries).toBe(50);
    expect(result.unknownRoots).toBe(0);
  });

  it('empties an invented type and forged call state, counting unknown roots', () => {
    const doc = new Y.Doc();
    doc.getMap('evil').set('payload', 'y'.repeat(1000));
    const evilList = doc.getArray('evil-list');
    for (let i = 0; i < 100; i += 1) evilList.push(['z'.repeat(500)]);
    doc.getMap('call').set('active', true);

    const result = sanitizeSharedDoc(doc);

    expect(doc.getMap('evil').size).toBe(0);
    expect(doc.getArray('evil-list').length).toBe(0);
    expect(doc.getMap('call').size).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.unknownRoots).toBe(2);
  });

  it('leaves a clean document untouched and reports nothing to do', () => {
    const doc = new Y.Doc();
    doc.getMap('fileReady').set('real-file-id', 123);
    doc.getMap('viewport').set('x', 4);
    doc.getMap('viewport').set('y', 5);
    doc.getMap('viewport').set('zoom', 1);

    const result = sanitizeSharedDoc(doc);

    expect(result.changed).toBe(false);
    expect(result.unknownRoots).toBe(0);
    expect(result.prunedEntries).toBe(0);
    expect(doc.getMap('viewport').size).toBe(3);
  });

  it('keeps the viewport contract and bounds cursors', () => {
    const doc = new Y.Doc();
    doc.getMap('viewport').set('x', 10);
    doc.getMap('viewport').set('junk', 'huge'.repeat(100));
    const cursors = doc.getMap('cursors');
    for (let i = 0; i < 600; i += 1) cursors.set(`peer-${i}`, { x: 1, y: 2 });

    sanitizeSharedDoc(doc);

    expect(doc.getMap('viewport').size).toBe(1);
    expect(doc.getMap('cursors').size).toBe(512);
  });
});

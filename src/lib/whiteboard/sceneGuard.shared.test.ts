import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildCleanDoc, sanitizeSharedDoc } from './sceneGuard';

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

  it('allows the boardsMeta map and caps a flood of invented boards', () => {
    const doc = new Y.Doc();
    const meta = doc.getMap('boardsMeta');
    for (let i = 0; i < 60; i += 1) {
      meta.set(`board-${i}`, { name: `Board ${i}`, order: i, createdAt: i });
    }

    const result = sanitizeSharedDoc(doc);

    expect(doc.getMap('boardsMeta').size).toBe(50);
    expect(result.changed).toBe(true);
  });

  it('drops boardsMeta entries that are not small plain objects', () => {
    const doc = new Y.Doc();
    const meta = doc.getMap('boardsMeta');
    meta.set('board-ok', { name: 'Board 1', order: 0 });
    meta.set('board-huge', { blob: 'x'.repeat(400) });

    sanitizeSharedDoc(doc);

    expect(doc.getMap('boardsMeta').size).toBe(1);
    expect(doc.getMap('boardsMeta').get('board-ok')).toEqual({ name: 'Board 1', order: 0 });
  });

  it('carries boardsMeta over in buildCleanDoc', () => {
    const doc = new Y.Doc();
    doc.getMap('boardsMeta').set('board-1', { name: 'Board 1', order: 0 });
    doc.getMap('fileReady').set('file-1', 5);

    const clean = buildCleanDoc(doc);

    expect(clean.getMap('boardsMeta').get('board-1')).toEqual({ name: 'Board 1', order: 0 });
    expect(clean.getMap('fileReady').get('file-1')).toBe(5);
  });

  it('prunes remotely created roots, which arrive as bare AbstractTypes', () => {
    // The sync path applies client updates into the server document, so its
    // root types are created by applyUpdate, not by getMap -- this build
    // registers those as bare AbstractTypes with no map or list interface.
    // Reproduce exactly that: build a source doc, apply its state into a
    // fresh doc, and prune the fresh one.
    const source = new Y.Doc();
    source.getMap('fileReady').set('flood-1', 'x'.repeat(300));
    source.getMap('evil').set('payload', 'y'.repeat(300));

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(source));
    expect(remote.getMap('fileReady').size).toBe(1);

    const result = sanitizeSharedDoc(remote);

    expect(remote.getMap('fileReady').size).toBe(0);
    expect(remote.getMap('evil').size).toBe(0);
    expect(result.changed).toBe(true);
    // One flood entry from the ruled map, plus evil's single emptied entry.
    expect(result.prunedEntries).toBe(2);
    expect(result.unknownRoots).toBe(1);
  });

  it('validates fileReady values as finite, non-negative numbers', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('fileReady');
    map.set('nan', Number.NaN);
    map.set('negative', -5);
    map.set('text', '5');
    map.set('valid', 42);

    sanitizeSharedDoc(doc);

    expect([...doc.getMap('fileReady').keys()]).toEqual(['valid']);
  });

  it('validates viewport entries as the three numbers the reader consumes', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('viewport');
    map.set('x', 10);
    map.set('y', 'left');
    map.set('zoom', Number.POSITIVE_INFINITY);
    map.set('spin', 90);

    sanitizeSharedDoc(doc);

    expect([...doc.getMap('viewport').keys()]).toEqual(['x']);
  });

  it('caps cursor rows and refuses oversized or live-type payloads', () => {
    const doc = new Y.Doc();
    const cursors = doc.getMap('cursors');
    cursors.set('peer-ok', { x: 1, y: 2 });
    cursors.set('peer-huge', { blob: 'x'.repeat(3000) });
    cursors.set('peer-live', new Y.Map());

    sanitizeSharedDoc(doc);

    expect([...doc.getMap('cursors').keys()]).toEqual(['peer-ok']);
  });

  it('applies the boardsMeta size budget to its definitions', () => {
    const doc = new Y.Doc();
    const meta = doc.getMap('boardsMeta');
    meta.set('board-edge', { name: 'x'.repeat(240) });
    meta.set('board-over', { name: 'x'.repeat(260) });

    sanitizeSharedDoc(doc);

    expect([...doc.getMap('boardsMeta').keys()]).toEqual(['board-edge']);
  });

  it('keeps remotely created allowed maps that hold valid entries', () => {
    const source = new Y.Doc();
    source.getMap('fileReady').set('file-1', 42);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(source));

    const result = sanitizeSharedDoc(remote);

    expect(remote.getMap('fileReady').size).toBe(1);
    expect(result.changed).toBe(false);
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

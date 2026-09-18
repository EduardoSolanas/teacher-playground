import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  buildCleanDoc,
  collectDocumentElements,
  sanitizeDocumentElements,
  sanitizeSharedDoc,
} from './sceneGuard';

function elementMap(element: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(element)) map.set(key, value);
  return map;
}

function sceneDoc(elements: Array<Record<string, unknown>>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>('elements').push(elements.map(elementMap));
  });
  return doc;
}

function idsIn(doc: Y.Doc): unknown[] {
  return doc.getArray<Y.Map<unknown>>('elements').toArray().map((map) => map.get('id'));
}

function documentElementRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    type: 'document',
    boardId: 'board-1',
    instanceId: 'instance-1',
    documentId: 'document-1',
    sharedPageIndex: 2,
    x: 40,
    y: 60,
    width: 320,
    height: 240,
    angle: 0,
    version: 3,
    label: 'Week 1 slides',
    ...overrides,
  };
}

/*
 * Applies an editor's change the way the sync socket does: the editor edits
 * its own copy of the room document and the resulting delta is applied to the
 * server's authoritative copy.
 */
function applyEditorDelta(server: Y.Doc, mutate: (editor: Y.Doc) => void): void {
  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(server));
  mutate(editor);
  Y.applyUpdate(server, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(server)));
}

function firstElement(doc: Y.Doc): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>('elements').get(0);
}

describe('sanitizeDocumentElements (owner-only document metadata)', () => {
  it('rejects an editor Yjs mutation of owner-only document metadata', () => {
    const doc = sceneDoc([documentElementRecord(), { id: 'rect-1', type: 'rectangle', x: 1 }]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      const element = editor.getArray<Y.Map<unknown>>('elements').get(0);
      element.set('sharedPageIndex', 9);
      element.set('documentId', 'forged-document');
      element.set('instanceId', 'forged-instance');
      element.set('boardId', 'forged-board');
      element.set('x', 500);
      element.set('width', 999);
      element.set('angle', 45);
      element.set('downloadUrl', '/rooms/r/documents/d/original');
    });

    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin));

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.removedUnauthorized).toBe(0);
    expect(result.revertedFields).toBe(7);
    expect(result.strippedFields).toBe(1);
    expect(origins).toEqual(['server-sanitize']);

    const element = firstElement(doc);
    expect(element.get('sharedPageIndex')).toBe(2);
    expect(element.get('documentId')).toBe('document-1');
    expect(element.get('instanceId')).toBe('instance-1');
    expect(element.get('boardId')).toBe('board-1');
    expect(element.get('x')).toBe(40);
    expect(element.get('width')).toBe(320);
    expect(element.get('angle')).toBe(0);
    expect(element.has('downloadUrl')).toBe(false);
    expect(idsIn(doc)).toEqual(['doc-1', 'rect-1']);
  });

  it('keeps an owner shared-page change that authoritative state already holds', () => {
    const doc = sceneDoc([documentElementRecord(), { id: 'rect-1', type: 'rectangle', x: 1 }]);

    // The owner shares page 3 through the trusted server path; the
    // authoritative document now holds it.
    firstElement(doc).set('sharedPageIndex', 3);

    const prior = collectDocumentElements(doc);
    applyEditorDelta(doc, (editor) => {
      const elements = editor.getArray<Y.Map<unknown>>('elements');
      // An editor republishing the scene re-sends the document element with
      // the authoritative values, and edits an annotation stroke.
      elements.get(0).set('sharedPageIndex', 3);
      elements.get(1).set('x', 500);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result).toEqual({
      changed: false,
      removedUnauthorized: 0,
      revertedFields: 0,
      strippedFields: 0,
    });
    expect(firstElement(doc).get('sharedPageIndex')).toBe(3);
    expect(doc.getArray<Y.Map<unknown>>('elements').get(1).get('x')).toBe(500);
  });

  it('removes a document element an editor created', () => {
    const doc = sceneDoc([{ id: 'rect-1', type: 'rectangle', x: 1 }]);
    const prior = collectDocumentElements(doc);
    expect(prior.size).toBe(0);

    applyEditorDelta(doc, (editor) => {
      const elements = editor.getArray<Y.Map<unknown>>('elements');
      elements.push([elementMap(documentElementRecord({ id: 'forged-1' }))]);
      elements.push([elementMap(documentElementRecord({ id: 'forged-2' }))]);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.removedUnauthorized).toBe(2);
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('removes a document element an editor created with a padded or cased type', () => {
    const doc = sceneDoc([{ id: 'rect-1', type: 'rectangle', x: 1 }]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      editor.getArray<Y.Map<unknown>>('elements')
        .push([elementMap(documentElementRecord({ id: 'forged-1', type: ' Document ' }))]);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.removedUnauthorized).toBe(1);
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('removes a document element whose id cannot key authoritative state', () => {
    const doc = sceneDoc([{ id: 'rect-1', type: 'rectangle', x: 1 }]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      const elements = editor.getArray<Y.Map<unknown>>('elements');
      elements.push([elementMap(documentElementRecord({ id: '' }))]);
      elements.push([elementMap(documentElementRecord({ id: ['forged'] }))]);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.removedUnauthorized).toBe(2);
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('removes an authoritative document element whose id cannot key prior state', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const elements = doc.getArray<Y.Map<unknown>>('elements');
      elements.push([elementMap({ id: 'rect-1', type: 'rectangle', x: 1 })]);
      elements.push([elementMap(documentElementRecord({ id: '' }))]);
      elements.push([elementMap(documentElementRecord({ id: ['forged'] }))]);
    });

    const prior = collectDocumentElements(doc);
    expect(prior.size).toBe(0);

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.removedUnauthorized).toBe(2);
    expect(idsIn(doc)).toEqual(['rect-1']);
  });

  it('restores a protected field the authoritative state does not hold by removing it', () => {
    const partial = documentElementRecord();
    delete partial.angle;
    const doc = sceneDoc([partial]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      editor.getArray<Y.Map<unknown>>('elements').get(0).set('angle', 45);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.revertedFields).toBe(1);
    expect(firstElement(doc).has('angle')).toBe(false);
  });

  it('skips entries that are not element maps or whose type is not a string', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const elements = doc.getArray<unknown>('elements');
      elements.push(['not-a-map']);
      elements.push([elementMap(documentElementRecord())]);
      elements.push([elementMap({ id: 'numeric-type', type: 7 })]);
    });
    const prior = collectDocumentElements(doc);
    expect(prior.size).toBe(1);

    applyEditorDelta(doc, (editor) => {
      editor.getArray<Y.Map<unknown>>('elements').get(1).set('sharedPageIndex', 9);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.revertedFields).toBe(1);
    const elements = doc.getArray<Y.Map<unknown>>('elements').toArray();
    expect(elements[0]).toBe('not-a-map');
    expect(elements[1].get('sharedPageIndex')).toBe(2);
    expect(elements[2].get('type')).toBe(7);
  });

  it('restores the type of a document element an editor overwrote', () => {
    const doc = sceneDoc([documentElementRecord()]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      editor.getArray<Y.Map<unknown>>('elements').get(0).set('type', 'freedraw');
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result.changed).toBe(true);
    expect(result.revertedFields).toBe(1);
    expect(firstElement(doc).get('type')).toBe('document');
  });

  it('leaves an editor ordinary-element edit unaffected', () => {
    const doc = sceneDoc([
      documentElementRecord(),
      { id: 'rect-1', type: 'rectangle', x: 1 },
      { id: 'stroke-1', type: 'freedraw', x: 100, points: [[0, 0], [5, 5]] },
    ]);
    const prior = collectDocumentElements(doc);

    applyEditorDelta(doc, (editor) => {
      const elements = editor.getArray<Y.Map<unknown>>('elements');
      elements.get(1).set('x', 42);
      elements.get(2).set('points', [[1, 1], [9, 9]]);
    });

    const result = sanitizeDocumentElements(doc, prior);

    expect(result).toEqual({
      changed: false,
      removedUnauthorized: 0,
      revertedFields: 0,
      strippedFields: 0,
    });
    const elements = doc.getArray<Y.Map<unknown>>('elements');
    expect(elements.get(1).get('x')).toBe(42);
    expect(elements.get(2).get('points')).toEqual([[1, 1], [9, 9]]);
    expect(elements.get(0).get('sharedPageIndex')).toBe(2);
  });

  it('carries document elements over in buildCleanDoc', () => {
    const doc = sceneDoc([documentElementRecord(), { id: 'rect-1', type: 'rectangle', x: 1 }]);

    const clean = buildCleanDoc(doc);

    const elements = clean.getArray<Y.Map<unknown>>('elements').toArray();
    expect(elements.map((map) => map.get('id'))).toEqual(['doc-1', 'rect-1']);
    expect(elements[0].get('type')).toBe('document');
    expect(elements[0].get('documentId')).toBe('document-1');
    expect(elements[0].get('sharedPageIndex')).toBe(2);
  });
});

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

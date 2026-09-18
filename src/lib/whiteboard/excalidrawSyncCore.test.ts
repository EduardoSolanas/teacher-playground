import { describe, expect, it } from 'vitest';

import {
  isMappedAppTool,
  mergeApiSnapshotElements,
  selectElementsForRemoteReconciliation,
  serializeExcalidrawElement,
  toExcalidrawToolType,
  uniqueElementsById,
} from './excalidrawSyncCore';

describe('isMappedAppTool', () => {
  it('knows the tools this application names', () => {
    expect(isMappedAppTool('rectangle')).toBe(true);
    expect(isMappedAppTool('circle')).toBe(true);
    expect(isMappedAppTool('pen')).toBe(true);
  });

  it('maps every tool this application names to its Excalidraw type', () => {
    expect(toExcalidrawToolType('select')).toBe('selection');
    expect(toExcalidrawToolType('pen')).toBe('freedraw');
    expect(toExcalidrawToolType('text')).toBe('text');
    expect(toExcalidrawToolType('rectangle')).toBe('rectangle');
    expect(toExcalidrawToolType('circle')).toBe('ellipse');
    expect(toExcalidrawToolType('line')).toBe('line');
    expect(toExcalidrawToolType('arrow')).toBe('arrow');
    expect(toExcalidrawToolType('stickyNote')).toBe('rectangle');
    expect(toExcalidrawToolType('eraser')).toBe('eraser');
  });

  it('accepts every Excalidraw element type the scene schema allows', () => {
    for (const type of [
      'rectangle',
      'diamond',
      'ellipse',
      'arrow',
      'line',
      'freedraw',
      'text',
      'image',
      'frame',
      'magicframe',
      'iframe',
      'embeddable',
    ]) {
      expect(serializeExcalidrawElement({ id: type, type })).toEqual({ id: type, type });
    }
  });

  describe('document element contract', () => {
    const documentElement = (overrides: Record<string, unknown> = {}) => ({
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
    });

    it('preserves a bounded document element without serializing manifest data', () => {
      const serialized = serializeExcalidrawElement(documentElement({
        manifest: { pages: [{ asset: 'rooms/r/documents/d/pages/0-1.webp' }] },
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=',
        base64: 'JVBERi0xLjQ=',
        downloadUrl: '/rooms/r/documents/d/original',
        diagnostics: { converter: 'libreoffice', exitCode: 1 },
        pageImages: [{ id: 'page-0', type: 'image' }],
        seed: 12345,
        versionNonce: 42,
        isDeleted: false,
        updated: 1,
        boundElements: null,
        link: '/rooms/r/documents/d/original',
      }));

      expect(serialized).toEqual({
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
      });
    });

    it('strips unknown extra fields so the allowlist stays closed', () => {
      const serialized = serializeExcalidrawElement(documentElement({
        futureField: { whatever: 'a future fork might add' },
        label: 42,
      }));

      expect(serialized).not.toHaveProperty('futureField');
      expect(serialized).not.toHaveProperty('label');
      expect(serialized).toEqual({
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
      });
    });

    it('rejects a document element missing a required bounded field', () => {
      const {
        id, type, boardId, instanceId, documentId, sharedPageIndex,
        x, y, width, height, angle, version,
      } = documentElement();
      for (const [key, value] of Object.entries({
        id, type, boardId, instanceId, documentId, sharedPageIndex,
        x, y, width, height, angle, version,
      })) {
        const partial: Record<string, unknown> = { boardId, instanceId, documentId, sharedPageIndex, x, y, width, height, angle, version, id, type };
        delete partial[key];
        expect(serializeExcalidrawElement(partial)).toBeNull();
      }
    });

    it('accepts shared page index zero', () => {
      const serialized = serializeExcalidrawElement(documentElement({ sharedPageIndex: 0 }));

      expect(serialized).not.toBeNull();
      expect(serialized?.sharedPageIndex).toBe(0);
    });

    it('rejects a document element whose bounded values are malformed', () => {
      expect(serializeExcalidrawElement(documentElement({ id: '' }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ boardId: '' }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ instanceId: 7 }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ documentId: null }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ sharedPageIndex: -1 }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ sharedPageIndex: 1.5 }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ sharedPageIndex: 'two' }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ x: Number.NaN }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ width: Number.POSITIVE_INFINITY }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ angle: 'upright' }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ version: 'three' }))).toBeNull();
      expect(serializeExcalidrawElement(documentElement({ version: Number.NaN }))).toBeNull();
    });

    it('serializes non-document elements exactly as before', () => {
      expect(serializeExcalidrawElement({
        id: 'rect-1',
        type: 'rectangle',
        seed: 1,
        junk: 'untouched by the document contract',
      })).toEqual({
        id: 'rect-1',
        type: 'rectangle',
        seed: 1,
        junk: 'untouched by the document contract',
      });
    });
  });

  it('does not treat a callable with element fields as a record', () => {
    const callable = Object.assign(() => {}, { id: 'fn', type: 'rectangle' });

    expect(serializeExcalidrawElement(callable)).toBeNull();
  });

  it('does not claim the tools only Excalidraw has', () => {
    /*
     * The reason this predicate exists. `toExcalidrawToolType` answers
     * `selection` for anything it does not know, which is right for asking
     * what to display and wrong for pushing back into the editor: diamond was
     * reported by Excalidraw, mapped to `selection` on the way out and sent
     * straight back, so the tool bounced to the arrow a moment after it was
     * picked. Everything here must be left alone rather than translated.
     */
    for (const tool of ['diamond', 'image', 'frame', 'laser', 'hand', 'embeddable']) {
      expect(isMappedAppTool(tool)).toBe(false);
      expect(toExcalidrawToolType(tool)).toBe('selection');
    }
  });

  it('is not fooled by names inherited from Object', () => {
    expect(isMappedAppTool('constructor')).toBe(false);
    expect(isMappedAppTool('toString')).toBe(false);
  });
});

describe('uniqueElementsById', () => {
  it('keeps the last copy of an id and drops entries with no usable id', () => {
    expect(
      uniqueElementsById([
        { id: 'a', width: 1 },
        {},
        { id: 42, width: 2 },
        { id: '', width: 3 },
        { id: 'a', width: 4 },
      ]),
    ).toEqual([{ id: 'a', width: 4 }]);
  });
});

describe('mergeApiSnapshotElements version handling', () => {
  const element = (id: string, version: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'rectangle',
    version,
    ...extra,
  });

  it('treats a non-finite version as oldest', () => {
    expect(
      mergeApiSnapshotElements(
        [element('a', Number.POSITIVE_INFINITY, { x: 1 })],
        [element('a', 2, { x: 2 })],
      ),
    ).toEqual([element('a', 2, { x: 2 })]);
  });

  it('treats a non-number version as oldest', () => {
    expect(
      mergeApiSnapshotElements(
        [element('a', 'nine', { x: 1 })],
        [element('a', 2, { x: 2 })],
      ),
    ).toEqual([element('a', 2, { x: 2 })]);
  });

  it('drops serializable elements that have no id to merge under', () => {
    expect(mergeApiSnapshotElements([{ type: 'rectangle' }], [])).toEqual([]);
    expect(mergeApiSnapshotElements([], [{ type: 'rectangle' }])).toEqual([]);
  });
});

describe('selectElementsForRemoteReconciliation id handling', () => {
  it('does not match a numeric id against a remote element', () => {
    const selected = selectElementsForRemoteReconciliation(
      [{ id: 42, type: 'rectangle' }],
      [{ id: 42, type: 'rectangle' }],
      { isPointerDown: false, seenRemoteIds: new Set(), lastPublishedIds: [] },
    );

    expect(selected.localElements).toEqual([]);
    expect(selected.remoteElements).toHaveLength(1);
  });

  it('drops a local element with no usable id even while the pointer is down', () => {
    const selected = selectElementsForRemoteReconciliation(
      [{ type: 'rectangle' }],
      [],
      { isPointerDown: true, seenRemoteIds: new Set(), lastPublishedIds: [] },
    );

    expect(selected.localElements).toEqual([]);
  });
});

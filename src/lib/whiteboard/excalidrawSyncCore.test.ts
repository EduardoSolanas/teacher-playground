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

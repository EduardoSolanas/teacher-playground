import { describe, expect, it } from 'vitest';
import {
  excalidrawElementsEqual,
  mergeApiSnapshotElements,
  selectElementsForRemoteReconciliation,
  serializeExcalidrawElement,
  serializeExcalidrawElements,
  toExcalidrawToolType,
  uniqueElementsById,
} from './excalidrawSyncCore';

// The API snapshot path intentionally remains separate from the live Yjs
// reconciliation adapter; these tests protect its version-only fallback.

describe('excalidraw sync helpers', () => {
  it('maps app tool ids to Excalidraw tool types', () => {
    expect(toExcalidrawToolType('select')).toBe('selection');
    expect(toExcalidrawToolType('pen')).toBe('freedraw');
    expect(toExcalidrawToolType('circle')).toBe('ellipse');
    expect(toExcalidrawToolType('unknown')).toBe('selection');
  });

  it('drops elements without a valid Excalidraw type', () => {
    expect(serializeExcalidrawElement({ id: 'bad' })).toBeNull();
    expect(serializeExcalidrawElement({ id: 'bad', type: 'pen' })).toBeNull();
    expect(serializeExcalidrawElements([
      { id: 'ok', type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] },
      { id: 'bad', type: undefined },
    ])).toHaveLength(1);
  });

  it('removes undefined object properties before writing to Yjs', () => {
    expect(serializeExcalidrawElement({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
      customData: undefined,
    })).toEqual({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
    });
  });

  it('keeps the last copy when reconciliation repeats an id', () => {
    expect(uniqueElementsById([
      { id: 'rect', type: 'rectangle', width: 10 },
      { id: 'ell', type: 'ellipse' },
      { id: 'rect', type: 'rectangle', width: 20 },
    ])).toEqual([
      { id: 'rect', type: 'rectangle', width: 20 },
      { id: 'ell', type: 'ellipse' },
    ]);
  });

  it('compares elements after serialization', () => {
    expect(excalidrawElementsEqual(
      [{ id: 'rect', type: 'rectangle', customData: undefined }],
      [{ id: 'rect', type: 'rectangle' }],
    )).toBe(true);
  });
});

describe('mergeApiSnapshotElements', () => {
  const element = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
    id, type: 'rectangle', version, ...extra,
  });

  it('keeps a local element the stale snapshot has not caught up with', () => {
    expect(mergeApiSnapshotElements(
      [element('a', 5, { x: 99 })],
      [element('a', 2, { x: 1 })],
    )).toEqual([element('a', 5, { x: 99 })]);
  });

  it('takes the remote element when it is newer', () => {
    expect(mergeApiSnapshotElements(
      [element('a', 1)],
      [element('a', 7, { x: 3 })],
    )).toEqual([element('a', 7, { x: 3 })]);
  });

  it('never drops a local element missing from the snapshot', () => {
    const merged = mergeApiSnapshotElements(
      [element('local-only', 1)],
      [element('remote-only', 1)],
    );
    expect(merged.map((item) => item.id).sort()).toEqual(['local-only', 'remote-only']);
  });

  it('adds elements the snapshot has and the scene does not', () => {
    expect(mergeApiSnapshotElements([], [element('a', 1)])).toEqual([element('a', 1)]);
  });

  it('prefers local on an equal version, so a redundant poll changes nothing', () => {
    expect(mergeApiSnapshotElements(
      [element('a', 3, { x: 10 })],
      [element('a', 3, { x: 20 })],
    )).toEqual([element('a', 3, { x: 10 })]);
  });

  it('treats a missing version as oldest rather than throwing', () => {
    expect(mergeApiSnapshotElements(
      [{ id: 'a', type: 'rectangle' }],
      [element('a', 1, { x: 5 })],
    )).toEqual([element('a', 1, { x: 5 })]);
  });

  it('ignores entries that are not valid Excalidraw elements', () => {
    const merged = mergeApiSnapshotElements(
      [element('a', 1)],
      [{ id: 'b', type: 'bogus' }, null],
    );
    expect(merged.map((item) => item.id)).toEqual(['a']);
  });
});

describe('selectElementsForRemoteReconciliation', () => {
  const element = (id: string, version: number, index: string) => ({
    id,
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    seed: 1,
    version,
    versionNonce: version,
    isDeleted: false,
    boundElements: null,
    updated: version,
    link: null,
    locked: false,
    frameId: null,
    index,
  });

  it('preserves only an unknown local element while a pointer is down', () => {
    const selected = selectElementsForRemoteReconciliation(
      [element('new-local', 5, 'a')],
      [element('remote', 2, 'b')],
      { isPointerDown: true, seenRemoteIds: new Set(), lastPublishedIds: [] },
    );

    expect(selected.localElements.map((item) => item.id)).toEqual(['new-local']);
    expect(selected.remoteElements.map((item) => item.id)).toEqual(['remote']);
  });

  it('does not resurrect a previously seen or published local element', () => {
    const local = [element('seen', 5, 'a'), element('published', 6, 'b')];
    const remote = [element('remote', 2, 'c')];

    expect(selectElementsForRemoteReconciliation(local, remote, {
      isPointerDown: true,
      seenRemoteIds: new Set(['seen']),
      lastPublishedIds: ['published'],
    }).localElements).toEqual([]);
  });

  it('keeps local versions for ids present remotely and remote ordering metadata intact', () => {
    const selected = selectElementsForRemoteReconciliation(
      [element('same', 9, 'f'), element('local', 3, '0')],
      [element('same', 2, '0.5'), element('remote', 4, '0.25')],
      { isPointerDown: false, seenRemoteIds: new Set(), lastPublishedIds: [] },
    );

    expect(selected.localElements.map((item) => [item.id, item.version])).toEqual([['same', 9]]);
    expect(selected.remoteElements.map((item) => [item.id, item.index])).toEqual([
      ['same', '0.5'],
      ['remote', '0.25'],
    ]);
  });

  it('makes an empty remote scene authoritative after the pointer is released', () => {
    const selected = selectElementsForRemoteReconciliation(
      [element('local', 5, 'a')],
      [],
      { isPointerDown: false, seenRemoteIds: new Set(), lastPublishedIds: [] },
    );

    expect(selected.localElements).toEqual([]);
    expect(selected.remoteElements).toEqual([]);
  });
});

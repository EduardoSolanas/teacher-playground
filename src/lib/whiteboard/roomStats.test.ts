import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createWhiteboardDoc, replaceSharedElements } from './yjsDoc';
import { computeRoomStats } from './roomStats';

/**
 * Pure stats computation driven by real Y.Docs.
 *
 * Content-free: no element text, points, image bytes, file ids, or participant names
 * ever appear in the stats object. Numbers and counts only.
 */

describe('roomStats', () => {
  it('computes stats for an empty room', () => {
    const { doc } = createWhiteboardDoc('test-room');
    const stats = computeRoomStats(doc);

    expect(stats.elements.total).toBe(0);
    expect(stats.elements.visible).toBe(0);
    expect(stats.elements.deleted).toBe(0);
    expect(stats.elementsByType).toEqual({});
    expect(stats.points.total).toBe(0);
    expect(stats.points.max).toBe(0);
    expect(stats.points.largestCount).toBe(0);
    expect(stats.snapshotBytes).toBeGreaterThan(0);
    expect(typeof stats.generatedAt).toBe('number');
    expect(stats.generatedAt).toBeGreaterThan(0);
  });

  it('counts elements and their types', () => {
    const { doc, elementsArray } = createWhiteboardDoc('test-room');
    replaceSharedElements(doc, elementsArray, [
      { id: 'box-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 'line-1', type: 'line', points: [[0, 0], [10, 10], [20, 20]] },
      { id: 'draw-1', type: 'freedraw', points: Array.from({ length: 50 }, (_, i) => [i, i]) },
      { id: 'text-1', type: 'text', x: 0, y: 0, text: 'hello world' },
      { id: 'box-2', type: 'rectangle', x: 100, y: 100, width: 50, height: 50 },
    ]);

    const stats = computeRoomStats(doc);
    expect(stats.elements.total).toBe(5);
    expect(stats.elements.visible).toBe(5);
    expect(stats.elements.deleted).toBe(0);
    expect(stats.elementsByType).toEqual({
      rectangle: 2,
      line: 1,
      freedraw: 1,
      text: 1,
    });
  });

  it('counts deleted elements separately and tracks points', () => {
    const { doc, elementsArray } = createWhiteboardDoc('test-room');
    replaceSharedElements(doc, elementsArray, [
      { id: 'draw-1', type: 'freedraw', points: Array.from({ length: 100 }, (_, i) => [i, i]) },
      { id: 'draw-2', type: 'freedraw', points: Array.from({ length: 50 }, (_, i) => [i, i]) },
      { id: 'box-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, isDeleted: true },
    ]);

    const stats = computeRoomStats(doc);
    expect(stats.elements.total).toBe(3);
    expect(stats.elements.visible).toBe(2);
    expect(stats.elements.deleted).toBe(1);
    expect(stats.points.total).toBe(150);
    expect(stats.points.max).toBe(100);
  });

  it('tracks the largest few elements by point count', () => {
    const { doc, elementsArray } = createWhiteboardDoc('test-room');
    replaceSharedElements(doc, elementsArray, [
      { id: 'draw-1', type: 'freedraw', points: Array.from({ length: 500 }, (_, i) => [i, i]) },
      { id: 'draw-2', type: 'freedraw', points: Array.from({ length: 300 }, (_, i) => [i, i]) },
      { id: 'draw-3', type: 'freedraw', points: Array.from({ length: 200 }, (_, i) => [i, i]) },
      { id: 'draw-4', type: 'freedraw', points: Array.from({ length: 100 }, (_, i) => [i, i]) },
      { id: 'draw-5', type: 'freedraw', points: Array.from({ length: 50 }, (_, i) => [i, i]) },
    ]);

    const stats = computeRoomStats(doc);
    expect(stats.points.total).toBe(1150);
    expect(stats.points.max).toBe(500);
    expect(stats.points.largest).toEqual([500, 300, 200]);
  });

  it('ensures snapshot bytes are real positive numbers', () => {
    const { doc, elementsArray } = createWhiteboardDoc('test-room');
    replaceSharedElements(doc, elementsArray, [
      { id: 'box-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    ]);

    const stats = computeRoomStats(doc);
    expect(stats.snapshotBytes).toBeGreaterThan(0);
    expect(Number.isFinite(stats.snapshotBytes)).toBe(true);
  });

  it('must not include any board content in the output', () => {
    const { doc, elementsArray } = createWhiteboardDoc('test-room');
    const distinctText = 'XYZZY_unique_marker_12345';
    replaceSharedElements(doc, elementsArray, [
      { id: 'text-1', type: 'text', text: distinctText, x: 0, y: 0 },
      { id: 'note-1', type: 'note', content: distinctText, x: 0, y: 0 },
      { id: 'box-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    ]);

    const stats = computeRoomStats(doc);
    const serialized = JSON.stringify(stats);

    // The distinctive string must not appear anywhere in the stats
    expect(serialized).not.toContain(distinctText);
    expect(serialized).not.toContain('unique_marker');
  });

  it('reports the stored row beside the document', () => {
    /*
     * The pair is the whole point. A document far larger than the row it
     * projects to is carrying history and tombstones rather than board, and
     * that is the difference between a room that wants pruning and one that
     * genuinely holds a term of work.
     */
    const { doc } = createWhiteboardDoc('rows');
    const stats = computeRoomStats(doc, 4096);
    expect(stats.rowBytes).toBe(4096);
    expect(computeRoomStats(doc).rowBytes).toBe(0);
  });

  it('reports the largest point count without spreading the whole board', () => {
    /*
     * `max` used to come from Math.max(...counts), which passes one argument
     * per element and overflows the call stack on a board with enough of them
     * -- and this report exists to be run on exactly those boards. It now
     * reads the head of the sorted list, so max and largest[0] cannot disagree.
     */
    const { doc, elementsArray } = createWhiteboardDoc('big');
    replaceSharedElements(doc, elementsArray, [
      { id: 'a', type: 'freedraw', points: Array.from({ length: 40 }, (_, i) => [i, i]) },
      { id: 'b', type: 'freedraw', points: Array.from({ length: 900 }, (_, i) => [i, i]) },
      { id: 'c', type: 'freedraw', points: Array.from({ length: 7 }, (_, i) => [i, i]) },
    ], 'seed');
    const stats = computeRoomStats(doc);
    expect(stats.points.max).toBe(900);
    expect(stats.points.largest[0]).toBe(stats.points.max);
    expect(stats.points.largest).toEqual([900, 40, 7]);
  });
});

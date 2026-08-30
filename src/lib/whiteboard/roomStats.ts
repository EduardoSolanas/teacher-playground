import * as Y from 'yjs';
import { decodePoints } from './pointCodec';

/**
 * Room statistics for diagnostic reporting.
 *
 * Contains no board content: no element text, points, image bytes, file ids,
 * or participant names. Numbers, counts, and byte sizes only.
 */
export interface RoomStats {
  elements: {
    total: number;
    visible: number;
    deleted: number;
  };
  elementsByType: Record<string, number>;
  points: {
    total: number;
    max: number;
    largest: number[];
    largestCount: number;
  };
  snapshotBytes: number;
  /**
   * The stored `elements` row beside the document.
   *
   * The pair is what makes the report answer anything: a document far larger
   * than the row it projects to is carrying history and tombstones rather than
   * board, which is the difference between a room that needs pruning and one
   * that genuinely holds a lot of work.
   */
  rowBytes: number;
  generatedAt: number;
}

/**
 * Compute diagnostic statistics from a room's live Y.Doc.
 *
 * Drives a real Y.Doc to count elements, calculate point totals, and
 * measure snapshot size. The output contains no board content.
 */
export function computeRoomStats(doc: Y.Doc, rowBytes = 0): RoomStats {
  const elementsArray = doc.getArray<Y.Map<any>>('elements');
  const elements = elementsArray.toArray();

  let totalCount = 0;
  let visibleCount = 0;
  let deletedCount = 0;
  const typeCount = new Map<string, number>();
  let totalPoints = 0;
  const elementPoints: number[] = [];

  for (const yMap of elements) {
    totalCount++;

    const type = yMap.get('type');
    if (typeof type === 'string') {
      typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
    }

    const isDeleted = yMap.get('isDeleted');
    if (isDeleted === true) {
      deletedCount++;
    } else {
      visibleCount++;
    }

    // Count points: decode whatever format they are in
    const pointsRaw = yMap.get('points');
    const decoded = decodePoints(pointsRaw);
    const pointCount = decoded ? decoded.length : 0;
    totalPoints += pointCount;
    elementPoints.push(pointCount);
  }

  /*
   * Sorted once, and read rather than re-scanned.
   *
   * `Math.max(...elementPoints)` passes one argument per element, so a board
   * with enough elements overflows the call stack -- and this report exists to
   * be run on exactly the boards that have too much in them, which is the
   * worst possible place for a limit that grows with the board. The list is
   * already ordered, so the largest is its first entry.
   */
  const largestPoints = [...elementPoints].sort((a, b) => b - a);
  const largest = largestPoints.slice(0, 3);

  const snapshotBytes = Y.encodeStateAsUpdate(doc).byteLength;

  return {
    elements: {
      total: totalCount,
      visible: visibleCount,
      deleted: deletedCount,
    },
    elementsByType: Object.fromEntries(typeCount),
    points: {
      total: totalPoints,
      max: largestPoints[0] ?? 0,
      largest,
      largestCount: largest.length,
    },
    snapshotBytes,
    rowBytes,
    generatedAt: Date.now(),
  };
}

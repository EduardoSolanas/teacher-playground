import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ArrowElement,
  CanvasElement,
  LineElement,
  PenStroke,
  RectangleElement,
} from '@/types/whiteboard';
import {
  deleteSelectedElements,
  deselectAll,
  duplicateSelectedElements,
  getSelectedElements,
  moveSelectedElements,
  selectElement,
  selectRectangle,
  toggleElementSelection,
} from './selection';
import * as store from './store';

let sequence = 0;

function uniqueId(label: string) {
  sequence += 1;
  return `${label}-${sequence}`;
}

function rectangle(id: string, x: number, y: number): RectangleElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 10,
    height: 10,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 1,
  };
}

function penStroke(id: string, points: { x: number; y: number }[]): PenStroke {
  return { id, type: 'pen', points, color: '#000000', strokeWidth: 1 };
}

function lineElement(id: string, points: { x: number; y: number }[]): LineElement {
  return { id, type: 'line', points, stroke: '#000000', strokeWidth: 1 };
}

function arrowElement(id: string, points: { x: number; y: number }[]): ArrowElement {
  return { id, type: 'arrow', points, stroke: '#000000', strokeWidth: 1 };
}

function idsOf(elements: CanvasElement[]) {
  return elements.map((element) => element.id);
}

function resetStore() {
  store.setElements([]);
  store.deselectAll();
  store.setViewport({ x: 0, y: 0, zoom: 1 });
}

describe('whiteboard selection helpers', () => {
  beforeEach(resetStore);

  it('toggleElementSelection adds, removes, and collapses the selection', () => {
    const first = rectangle(uniqueId('toggle'), 0, 0);
    const second = rectangle(uniqueId('toggle'), 20, 20);
    store.setElements([first, second]);

    toggleElementSelection(store, first.id);
    expect(store.getState().selectedIds).toEqual([first.id]);

    toggleElementSelection(store, second.id);
    expect(store.getState().selectedIds).toEqual([first.id, second.id]);

    toggleElementSelection(store, first.id);
    expect(store.getState().selectedIds).toEqual([second.id]);

    toggleElementSelection(store, second.id);
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('selectElement and deselectAll pass through to the store', () => {
    const only = rectangle(uniqueId('passthrough'), 0, 0);
    store.setElements([only]);

    selectElement(store, only.id);
    expect(store.getState().selectedIds).toEqual([only.id]);

    deselectAll(store);
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('selectRectangle normalizes a reversed drag through the viewport offset and zoom', () => {
    const inside = rectangle(uniqueId('rect'), 0, 0);
    const negative = rectangle(uniqueId('rect'), -20, -20);
    const far = rectangle(uniqueId('rect'), 30, 30);
    const below = rectangle(uniqueId('rect'), 0, 30);
    const outside = rectangle(uniqueId('rect'), 100, 100);
    store.setElements([inside, negative, far, below, outside]);
    store.setViewport({ x: 30, y: 40, zoom: 2 });

    selectRectangle(store, 80, 90, 0, 0);

    expect(store.getState().selectedIds).toEqual([inside.id, negative.id]);
  });

  it('selectRectangle handles a forward drag when zoomed out', () => {
    const target = rectangle(uniqueId('rect'), 30, 40);
    const leftGap = rectangle(uniqueId('rect'), 0, 40);
    const belowGap = rectangle(uniqueId('rect'), 30, 0);
    const past = rectangle(uniqueId('rect'), 70, 40);
    store.setElements([target, leftGap, belowGap, past]);
    store.setViewport({ x: -10, y: -20, zoom: 0.5 });

    selectRectangle(store, 0, 0, 20, 20);

    expect(store.getState().selectedIds).toEqual([target.id]);
  });

  it('selectRectangle includes rectangles whose edges touch the marquee and excludes disjoint ones', () => {
    const left = rectangle(uniqueId('edge'), 0, 0);
    const right = rectangle(uniqueId('edge'), 20, 0);
    const disjoint = rectangle(uniqueId('edge'), 20.5, 0);
    const detached = rectangle(uniqueId('edge'), -20.5, 0);
    store.setElements([left, right, disjoint, detached]);

    selectRectangle(store, 10, 0, 20, 10);

    expect(store.getState().selectedIds).toEqual([left.id, right.id]);
  });

  it('selectRectangle includes shapes touching the top and bottom of the marquee', () => {
    const below = rectangle(uniqueId('vertical'), 0, 0);
    const above = rectangle(uniqueId('vertical'), 0, 20);
    const gapAbove = rectangle(uniqueId('vertical'), 0, 20.5);
    const gapBelow = rectangle(uniqueId('vertical'), 0, -20.5);
    store.setElements([below, above, gapAbove, gapBelow]);

    selectRectangle(store, 0, 10, 10, 20);

    expect(store.getState().selectedIds).toEqual([below.id, above.id]);
  });

  it('selectRectangle matches pen, line and arrow through any inside point', () => {
    const pen = penStroke(uniqueId('linear'), [
      { x: 0, y: 0 },
      { x: 55, y: 55 },
    ]);
    const line = lineElement(uniqueId('linear'), [
      { x: 0, y: 0 },
      { x: 55, y: 55 },
    ]);
    const arrow = arrowElement(uniqueId('linear'), [
      { x: 40, y: 40 },
      { x: 50, y: 60 },
    ]);
    const rightEdge = penStroke(uniqueId('linear'), [{ x: 60, y: 55 }]);
    const topEdge = penStroke(uniqueId('linear'), [{ x: 55, y: 50 }]);
    const xOutside = penStroke(uniqueId('linear'), [{ x: 0, y: 55 }]);
    const yOutside = penStroke(uniqueId('linear'), [{ x: 55, y: 100 }]);
    const xBeyond = penStroke(uniqueId('linear'), [{ x: 100, y: 55 }]);
    const yBelow = penStroke(uniqueId('linear'), [{ x: 55, y: 0 }]);
    const empty = penStroke(uniqueId('linear'), []);
    store.setElements([
      pen,
      line,
      arrow,
      rightEdge,
      topEdge,
      xOutside,
      yOutside,
      xBeyond,
      yBelow,
      empty,
    ]);

    selectRectangle(store, 50, 50, 60, 60);

    expect(store.getState().selectedIds).toEqual([
      pen.id,
      line.id,
      arrow.id,
      rightEdge.id,
      topEdge.id,
    ]);
  });

  it('getSelectedElements follows board order, not selection order', () => {
    const first = rectangle(uniqueId('order'), 0, 0);
    const second = rectangle(uniqueId('order'), 20, 20);
    const third = rectangle(uniqueId('order'), 40, 40);
    store.setElements([first, second, third]);

    store.selectMultiple([third.id, first.id]);

    expect(idsOf(getSelectedElements(store))).toEqual([first.id, third.id]);
  });

  it('moveSelectedElements offsets shapes and point elements and skips unknown ids', () => {
    const shape = rectangle(uniqueId('move'), 10, 20);
    const stroke = penStroke(uniqueId('move'), [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    const untouched = rectangle(uniqueId('move'), 100, 100);
    store.setElements([shape, stroke, untouched]);
    store.selectMultiple([shape.id, stroke.id, uniqueId('move-ghost')]);

    moveSelectedElements(store, 5, -7);

    const movedShape = store.getState().elements[0] as RectangleElement;
    const movedStroke = store.getState().elements[1] as PenStroke;
    expect(movedShape.x).toBe(15);
    expect(movedShape.y).toBe(13);
    expect(movedStroke.points).toEqual([
      { x: 6, y: -5 },
      { x: 8, y: -3 },
    ]);
    expect((movedStroke as unknown as { x?: number }).x).toBeUndefined();
    expect((movedShape as unknown as { points?: unknown }).points).toBeUndefined();
    expect(store.getState().elements[2]).toBe(untouched);
  });

  it('moveSelectedElements leaves a partially shaped element untouched', () => {
    const partial = {
      id: uniqueId('move-partial'),
      type: 'rectangle',
      x: 10,
    } as unknown as CanvasElement;
    store.setElements([partial]);
    store.selectElement(partial.id);

    moveSelectedElements(store, 5, 5);

    const moved = store.getState().elements[0] as unknown as { x: number; y?: number };
    expect(moved.x).toBe(10);
    expect(moved.y).toBeUndefined();
  });

  it('deleteSelectedElements removes and deselects the selection', () => {
    const first = rectangle(uniqueId('delete'), 0, 0);
    const second = rectangle(uniqueId('delete'), 20, 20);
    const third = rectangle(uniqueId('delete'), 40, 40);
    store.setElements([first, second, third]);
    store.selectMultiple([first.id, second.id, uniqueId('delete-ghost')]);

    deleteSelectedElements(store);

    expect(idsOf(store.getState().elements)).toEqual([third.id]);
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('duplicateSelectedElements offsets and selects only the copies', () => {
    const shape = rectangle(uniqueId('duplicate'), 10, 20);
    const stroke = penStroke(uniqueId('duplicate'), [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    store.setElements([shape, stroke]);
    store.selectMultiple([shape.id, stroke.id]);

    duplicateSelectedElements(store);

    const elements = store.getState().elements;
    expect(elements).toHaveLength(4);
    const shapeCopy = elements[2] as RectangleElement;
    const strokeCopy = elements[3] as PenStroke;
    expect(shapeCopy.id).not.toBe(shape.id);
    expect(strokeCopy.id).not.toBe(stroke.id);
    expect(shapeCopy.id).not.toBe(strokeCopy.id);
    expect(shapeCopy.type).toBe('rectangle');
    expect(strokeCopy.type).toBe('pen');
    expect(shapeCopy.x).toBe(30);
    expect(shapeCopy.y).toBe(40);
    expect(shapeCopy.width).toBe(10);
    expect(strokeCopy.points).toEqual([
      { x: 21, y: 22 },
      { x: 23, y: 24 },
    ]);
    expect((strokeCopy as unknown as { x?: number }).x).toBeUndefined();
    expect((shapeCopy as unknown as { points?: unknown }).points).toBeUndefined();
    expect(store.getState().selectedIds).toEqual([shapeCopy.id, strokeCopy.id]);
    expect(store.getState().elements[0]).toBe(shape);
    expect(store.getState().elements[1]).toBe(stroke);
  });

  it('duplicateSelectedElements does not invent offsets for a partially shaped element', () => {
    const partial = {
      id: uniqueId('duplicate-partial'),
      type: 'rectangle',
      x: 10,
    } as unknown as CanvasElement;
    store.setElements([partial]);
    store.selectElement(partial.id);

    duplicateSelectedElements(store);

    const copy = store.getState().elements[1] as unknown as { x: number; y?: number };
    expect(copy.x).toBe(10);
    expect(copy.y).toBeUndefined();
  });

  it('duplicateSelectedElements leaves a ghost-only selection alone', () => {
    const only = rectangle(uniqueId('duplicate-ghost'), 0, 0);
    store.setElements([only]);
    const ghost = uniqueId('duplicate-ghost');
    store.selectMultiple([ghost]);

    duplicateSelectedElements(store);

    expect(store.getState().elements).toHaveLength(1);
    expect(store.getState().selectedIds).toEqual([ghost]);
  });
});

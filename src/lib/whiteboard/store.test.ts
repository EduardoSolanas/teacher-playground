import { beforeEach, describe, expect, it } from 'vitest';

import type { CanvasElement, PenStroke, RectangleElement } from '@/types/whiteboard';
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

function idsOf(elements: CanvasElement[]) {
  return elements.map((element) => element.id);
}

function notificationsFrom(action: () => void) {
  let count = 0;
  const unsubscribe = store.subscribe(() => {
    count += 1;
  });
  try {
    action();
  } finally {
    unsubscribe();
  }
  return count;
}

function resetStore() {
  store.setElements([]);
  store.deselectAll();
  store.setTool('select');
  store.setPalette({ color: '#000000', strokeWidth: 2, fill: 'transparent' });
  store.setViewport({ x: 0, y: 0, zoom: 1 });
  store.setCurrentElement(null);
  for (const group of [...store.getState().groups]) {
    store.ungroup(group.id);
  }
}

describe('whiteboard store', () => {
  it('reports no history before the first snapshot is pushed', () => {
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.undo()).toBeNull();
    expect(store.redo()).toBeNull();
    expect(store.getState().elements).toEqual([]);
    expect(store.getState().selectedIds).toEqual([]);
    expect(store.getState().tool).toBe('select');
    expect(store.getState().palette).toEqual({
      color: '#000000',
      strokeWidth: 2,
      fill: 'transparent',
    });
    expect(store.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(store.getState().groups).toEqual([]);
    expect(store.getState().currentElement).toBeNull();
  });

  describe('element operations', () => {
    beforeEach(resetStore);

    it('appends an element and notifies subscribers', () => {
      const first = rectangle(uniqueId('add'), 0, 0);
      const second = rectangle(uniqueId('add'), 5, 5);

      expect(notificationsFrom(() => store.addElement(first))).toBe(1);
      expect(store.getState().elements).toEqual([first]);

      expect(notificationsFrom(() => store.addElement(second))).toBe(1);
      expect(idsOf(store.getState().elements)).toEqual([first.id, second.id]);
    });

    it('merges updates into the matching element only', () => {
      const first = rectangle(uniqueId('update'), 0, 0);
      const second = rectangle(uniqueId('update'), 30, 30);
      store.setElements([first, second]);

      expect(
        notificationsFrom(() => store.updateElement(first.id, { x: 12, fill: '#123456' })),
      ).toBe(1);

      const updated = store.getState().elements[0] as RectangleElement;
      expect(updated.id).toBe(first.id);
      expect(updated.x).toBe(12);
      expect(updated.y).toBe(0);
      expect(updated.fill).toBe('#123456');
      expect(store.getState().elements[1]).toBe(second);
    });

    it('removes an element and drops its id from the selection', () => {
      const first = rectangle(uniqueId('remove'), 0, 0);
      const second = rectangle(uniqueId('remove'), 30, 30);
      store.setElements([first, second]);
      store.selectMultiple([first.id, second.id]);

      expect(notificationsFrom(() => store.removeElement(first.id))).toBe(1);

      expect(idsOf(store.getState().elements)).toEqual([second.id]);
      expect(store.getState().selectedIds).toEqual([second.id]);
    });

    it('setElements replaces the whole board', () => {
      const first = rectangle(uniqueId('set'), 0, 0);
      const second = rectangle(uniqueId('set'), 30, 30);

      expect(notificationsFrom(() => store.setElements([first]))).toBe(1);
      expect(notificationsFrom(() => store.setElements([second]))).toBe(1);

      expect(store.getState().elements).toEqual([second]);
    });

    it('duplicateElement appends an offset copy and selects it', () => {
      const source = rectangle(uniqueId('duplicate'), 40, 50);
      store.setElements([source]);

      store.duplicateElement(source.id);

      const [original, copy] = store.getState().elements as RectangleElement[];
      expect(store.getState().elements).toHaveLength(2);
      expect(original).toBe(source);
      expect(copy.id).not.toBe(source.id);
      expect(copy.x).toBe(60);
      expect(copy.y).toBe(70);
      expect(copy.width).toBe(10);
      expect(store.getState().selectedIds).toEqual([copy.id]);
    });

    it('duplicateElement keeps point elements at the origin with unchanged points', () => {
      const source = penStroke(uniqueId('duplicate-pen'), [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]);
      store.setElements([source]);

      store.duplicateElement(source.id);

      const copy = store.getState().elements[1] as PenStroke;
      expect(copy).not.toBe(source);
      expect(copy.id).not.toBe(source.id);
      expect(copy.points).toEqual([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]);
      expect((copy as unknown as { x: number }).x).toBe(0);
      expect((copy as unknown as { y: number }).y).toBe(0);
      expect(store.getState().selectedIds).toEqual([copy.id]);
    });

    it('duplicateElement ignores an unknown id', () => {
      const source = rectangle(uniqueId('duplicate-missing'), 0, 0);
      store.setElements([source]);

      store.duplicateElement(uniqueId('duplicate-missing'));

      expect(store.getState().elements).toEqual([source]);
      expect(store.getState().selectedIds).toEqual([]);
    });

    it('moveElement updates the element through updateElement', () => {
      const element = rectangle(uniqueId('move'), 0, 0);
      store.setElements([element]);

      store.moveElement(element.id, { x: 99 });

      expect((store.getState().elements[0] as RectangleElement).x).toBe(99);
    });
  });

  describe('selection', () => {
    beforeEach(resetStore);

    it('selectElement, selectMultiple and deselectAll replace the selection and notify', () => {
      const first = rectangle(uniqueId('select'), 0, 0);
      const second = rectangle(uniqueId('select'), 30, 30);
      store.setElements([first, second]);

      expect(notificationsFrom(() => store.selectElement(first.id))).toBe(1);
      expect(store.getState().selectedIds).toEqual([first.id]);

      expect(notificationsFrom(() => store.selectMultiple([first.id, second.id]))).toBe(1);
      expect(store.getState().selectedIds).toEqual([first.id, second.id]);

      expect(notificationsFrom(() => store.deselectAll())).toBe(1);
      expect(store.getState().selectedIds).toEqual([]);
    });

    it('unsubscribing stops later notifications', () => {
      let notifications = 0;
      const unsubscribe = store.subscribe(() => {
        notifications += 1;
      });

      store.selectElement(uniqueId('unsubscribe'));
      unsubscribe();
      store.selectElement(uniqueId('unsubscribe'));

      expect(notifications).toBe(1);
    });

    it('a throwing listener does not stop later listeners, and the failure is logged', () => {
      const logged: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(' '));
      };

      const seen: string[] = [];
      const unsubscribers: Array<() => void> = [];
      try {
        unsubscribers.push(
          store.subscribe(() => {
            throw new Error('listener boom');
          }),
        );
        unsubscribers.push(
          store.subscribe(() => {
            seen.push('later listener');
          }),
        );

        store.selectElement(uniqueId('throwing'));
      } finally {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
        console.error = originalError;
      }

      expect(seen).toEqual(['later listener']);
      expect(logged.some((line) => line.includes('[store] listener threw'))).toBe(true);
      expect(logged.some((line) => line.includes('listener boom'))).toBe(true);
    });
  });

  describe('settings', () => {
    beforeEach(resetStore);

    it('setTool changes the active tool', () => {
      expect(notificationsFrom(() => store.setTool('pen'))).toBe(1);
      expect(store.getState().tool).toBe('pen');
    });

    it('setPalette merges into the existing palette', () => {
      expect(notificationsFrom(() => store.setPalette({ strokeWidth: 9 }))).toBe(1);
      expect(store.getState().palette).toEqual({
        color: '#000000',
        strokeWidth: 9,
        fill: 'transparent',
      });

      store.setPalette({ color: '#ff0000', fill: '#00ff00' });
      expect(store.getState().palette).toEqual({
        color: '#ff0000',
        strokeWidth: 9,
        fill: '#00ff00',
      });
    });

    it('setViewport merges into the existing viewport', () => {
      expect(notificationsFrom(() => store.setViewport({ zoom: 2 }))).toBe(1);
      expect(store.getState().viewport).toEqual({ x: 0, y: 0, zoom: 2 });

      store.setViewport({ x: 30, y: 40 });
      expect(store.getState().viewport).toEqual({ x: 30, y: 40, zoom: 2 });
    });

    it('setCurrentElement records and clears the in-progress element', () => {
      const element = rectangle(uniqueId('current'), 0, 0);

      expect(notificationsFrom(() => store.setCurrentElement(element))).toBe(1);
      expect(store.getState().currentElement).toBe(element);

      store.setCurrentElement(null);
      expect(store.getState().currentElement).toBeNull();
    });
  });

  describe('stacking order', () => {
    beforeEach(resetStore);

    it('bringForward swaps an element with the one after it', () => {
      const first = rectangle(uniqueId('forward'), 0, 0);
      const second = rectangle(uniqueId('forward'), 0, 0);
      const third = rectangle(uniqueId('forward'), 0, 0);
      store.setElements([first, second, third]);

      expect(notificationsFrom(() => store.bringForward(first.id))).toBe(1);

      expect(idsOf(store.getState().elements)).toEqual([second.id, first.id, third.id]);
    });

    it('bringForward keeps the last element and unknown ids untouched', () => {
      const first = rectangle(uniqueId('forward-edge'), 0, 0);
      const last = rectangle(uniqueId('forward-edge'), 0, 0);
      store.setElements([first, last]);

      expect(notificationsFrom(() => store.bringForward(last.id))).toBe(0);
      expect(notificationsFrom(() => store.bringForward(uniqueId('forward-edge')))).toBe(0);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
    });

    it('sendBackward swaps an element with the one before it', () => {
      const first = rectangle(uniqueId('backward'), 0, 0);
      const second = rectangle(uniqueId('backward'), 0, 0);
      const third = rectangle(uniqueId('backward'), 0, 0);
      store.setElements([first, second, third]);

      expect(notificationsFrom(() => store.sendBackward(third.id))).toBe(1);

      expect(idsOf(store.getState().elements)).toEqual([first.id, third.id, second.id]);
    });

    it('sendBackward keeps the first element and unknown ids untouched', () => {
      const first = rectangle(uniqueId('backward-edge'), 0, 0);
      const last = rectangle(uniqueId('backward-edge'), 0, 0);
      store.setElements([first, last]);

      expect(notificationsFrom(() => store.sendBackward(first.id))).toBe(0);
      expect(notificationsFrom(() => store.sendBackward(uniqueId('backward-edge')))).toBe(0);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
    });

    it('bringToFront moves the first element to the end', () => {
      const first = rectangle(uniqueId('front'), 0, 0);
      const second = rectangle(uniqueId('front'), 0, 0);
      const third = rectangle(uniqueId('front'), 0, 0);
      store.setElements([first, second, third]);

      expect(notificationsFrom(() => store.bringToFront(first.id))).toBe(1);

      expect(idsOf(store.getState().elements)).toEqual([second.id, third.id, first.id]);
    });

    it('bringToFront keeps the last element in place and ignores unknown ids', () => {
      const first = rectangle(uniqueId('front-edge'), 0, 0);
      const last = rectangle(uniqueId('front-edge'), 0, 0);
      store.setElements([first, last]);

      expect(notificationsFrom(() => store.bringToFront(last.id))).toBe(1);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
      expect(notificationsFrom(() => store.bringToFront(uniqueId('front-edge')))).toBe(0);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
    });

    it('sendToBack moves the last element to the front', () => {
      const first = rectangle(uniqueId('back'), 0, 0);
      const second = rectangle(uniqueId('back'), 0, 0);
      const third = rectangle(uniqueId('back'), 0, 0);
      store.setElements([first, second, third]);

      expect(notificationsFrom(() => store.sendToBack(third.id))).toBe(1);

      expect(idsOf(store.getState().elements)).toEqual([third.id, first.id, second.id]);
    });

    it('sendToBack keeps the first element in place and ignores unknown ids', () => {
      const first = rectangle(uniqueId('back-edge'), 0, 0);
      const last = rectangle(uniqueId('back-edge'), 0, 0);
      store.setElements([first, last]);

      expect(notificationsFrom(() => store.sendToBack(first.id))).toBe(1);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
      expect(notificationsFrom(() => store.sendToBack(uniqueId('back-edge')))).toBe(0);
      expect(idsOf(store.getState().elements)).toEqual([first.id, last.id]);
    });
  });

  describe('history', () => {
    beforeEach(resetStore);

    it('undo returns the previous snapshot and redo restores the latest', () => {
      const first = rectangle(uniqueId('history'), 0, 0);
      const second = rectangle(uniqueId('history'), 10, 10);
      store.setElements([first]);
      store.addElement(second);

      expect(store.canUndo()).toBe(true);
      expect(idsOf(store.getState().elements)).toEqual([first.id, second.id]);

      let undone: CanvasElement[] | null = null;
      expect(
        notificationsFrom(() => {
          undone = store.undo();
        }),
      ).toBe(1);
      expect(idsOf(undone ?? [])).toEqual([first.id]);
      expect(idsOf(store.getState().elements)).toEqual([first.id]);
      expect(store.canRedo()).toBe(true);

      let redone: CanvasElement[] | null = null;
      expect(
        notificationsFrom(() => {
          redone = store.redo();
        }),
      ).toBe(1);
      expect(idsOf(redone ?? [])).toEqual([first.id, second.id]);
      expect(idsOf(store.getState().elements)).toEqual([first.id, second.id]);
      expect(store.canUndo()).toBe(true);
    });

    it('updateElement records history so an undo restores the previous geometry', () => {
      const element = rectangle(uniqueId('history-update'), 0, 0);
      store.setElements([element]);
      store.updateElement(element.id, { x: 30 });
      expect((store.getState().elements[0] as RectangleElement).x).toBe(30);

      store.undo();

      expect(idsOf(store.getState().elements)).toEqual([element.id]);
      expect((store.getState().elements[0] as RectangleElement).x).toBe(0);
    });

    it('removeElement records history so an undo restores the element', () => {
      const first = rectangle(uniqueId('history-remove'), 0, 0);
      const second = rectangle(uniqueId('history-remove'), 10, 10);
      store.setElements([first, second]);
      store.removeElement(first.id);
      expect(idsOf(store.getState().elements)).toEqual([second.id]);

      store.undo();

      expect(idsOf(store.getState().elements)).toEqual([first.id, second.id]);
    });

    it('pushHistorySnapshot records the current board for a later undo', () => {
      const first = rectangle(uniqueId('snapshot'), 0, 0);
      const second = rectangle(uniqueId('snapshot'), 10, 10);
      store.setElements([first]);
      store.setElements([first, second]);
      store.undo();
      expect(idsOf(store.getState().elements)).toEqual([first.id]);

      store.pushHistorySnapshot();
      const restored = store.undo();

      expect(idsOf(restored ?? [])).toEqual([first.id]);
    });

    it('getHistoryManager exposes the live history used by undo', () => {
      expect(store.getHistoryManager()).toBe(store.getHistoryManager());
      store.setElements([rectangle(uniqueId('manager'), 0, 0)]);
      expect(store.getHistoryManager().canUndo()).toBe(true);
    });
  });

  describe('groups', () => {
    beforeEach(resetStore);

    it('groups two or more selected elements', () => {
      const first = rectangle(uniqueId('group'), 0, 0);
      const second = rectangle(uniqueId('group'), 20, 20);
      const third = rectangle(uniqueId('group'), 40, 40);
      store.setElements([first, second, third]);
      store.selectMultiple([first.id, second.id]);

      expect(notificationsFrom(() => store.groupSelectedElements())).toBe(1);

      expect(store.getState().groups).toHaveLength(1);
      expect(store.getState().groups[0].memberIds).toEqual([first.id, second.id]);
      expect(store.getGroupForElement(first.id)?.id).toBe(store.getState().groups[0].id);
      expect(store.getGroupForElement(third.id)).toBeUndefined();
      expect(store.getGroupForElement(uniqueId('group-ghost'))).toBeUndefined();
    });

    it('does not group a lone selection or ids that are not on the board', () => {
      const only = rectangle(uniqueId('group-lone'), 0, 0);
      store.setElements([only]);

      store.selectElement(only.id);
      store.groupSelectedElements();
      expect(store.getState().groups).toEqual([]);

      store.selectMultiple([only.id, uniqueId('group-ghost')]);
      store.groupSelectedElements();
      expect(store.getState().groups).toEqual([]);
    });

    it('does not group several stale ids while a real element is on the board', () => {
      const only = rectangle(uniqueId('group-stale'), 0, 0);
      store.setElements([only]);
      store.selectMultiple([only.id, uniqueId('group-stale'), uniqueId('group-stale')]);

      store.groupSelectedElements();

      expect(store.getState().groups).toEqual([]);
    });

    it('joins an existing group when a selected element is already a member', () => {
      const first = rectangle(uniqueId('group-join'), 0, 0);
      const second = rectangle(uniqueId('group-join'), 20, 20);
      const third = rectangle(uniqueId('group-join'), 40, 40);
      store.setElements([first, second, third]);
      store.selectMultiple([first.id, second.id]);
      store.groupSelectedElements();
      const groupId = store.getState().groups[0].id;

      store.selectMultiple([first.id, third.id]);
      store.groupSelectedElements();

      expect(store.getState().groups).toHaveLength(1);
      expect(store.getState().groups[0].id).toBe(groupId);
      expect(store.getState().groups[0].memberIds).toEqual([first.id, second.id, third.id]);
    });

    it('joins only the group that contains a selected member', () => {
      const first = rectangle(uniqueId('group-select'), 0, 0);
      const second = rectangle(uniqueId('group-select'), 10, 10);
      const third = rectangle(uniqueId('group-select'), 20, 20);
      const fourth = rectangle(uniqueId('group-select'), 30, 30);
      const fifth = rectangle(uniqueId('group-select'), 40, 40);
      store.setElements([first, second, third, fourth, fifth]);
      store.selectMultiple([first.id, second.id]);
      store.groupSelectedElements();
      const firstGroupId = store.getState().groups[0].id;
      store.selectMultiple([third.id, fourth.id]);
      store.groupSelectedElements();
      const secondGroupId = store.getState().groups[1].id;

      store.selectMultiple([first.id, fifth.id]);
      store.groupSelectedElements();

      expect(store.getState().groups).toHaveLength(2);
      expect(store.getState().groups[0].id).toBe(firstGroupId);
      expect(store.getState().groups[0].memberIds).toEqual([first.id, second.id, fifth.id]);
      expect(store.getState().groups[1].id).toBe(secondGroupId);
      expect(store.getState().groups[1].memberIds).toEqual([third.id, fourth.id]);
    });

    it('dedupes members when joining a group', () => {
      const first = rectangle(uniqueId('group-dedupe'), 0, 0);
      const second = rectangle(uniqueId('group-dedupe'), 20, 20);
      const third = rectangle(uniqueId('group-dedupe'), 40, 40);
      store.setElements([first, second, third]);
      store.selectMultiple([first.id, second.id]);
      store.groupSelectedElements();

      store.selectMultiple([first.id, second.id, third.id]);
      store.groupSelectedElements();

      expect(store.getState().groups).toHaveLength(1);
      expect(store.getState().groups[0].memberIds).toEqual([first.id, second.id, third.id]);
    });

    it('ungroup removes only the named group and ignores unknown ids', () => {
      const first = rectangle(uniqueId('ungroup'), 0, 0);
      const second = rectangle(uniqueId('ungroup'), 10, 10);
      const third = rectangle(uniqueId('ungroup'), 20, 20);
      const fourth = rectangle(uniqueId('ungroup'), 30, 30);
      store.setElements([first, second, third, fourth]);
      store.selectMultiple([first.id, second.id]);
      store.groupSelectedElements();
      const firstGroupId = store.getState().groups[0].id;
      store.selectMultiple([third.id, fourth.id]);
      store.groupSelectedElements();
      const secondGroupId = store.getState().groups[1].id;

      expect(notificationsFrom(() => store.ungroup(firstGroupId))).toBe(1);

      expect(store.getState().groups).toHaveLength(1);
      expect(store.getState().groups[0].id).toBe(secondGroupId);
      expect(store.getGroupForElement(first.id)).toBeUndefined();
      expect(store.getGroupForElement(third.id)?.id).toBe(secondGroupId);

      store.ungroup(uniqueId('ungroup-ghost'));
      expect(store.getState().groups).toHaveLength(1);
    });

    it('moveGroup offsets shapes and points for every member', () => {
      const shape = rectangle(uniqueId('move-group'), 10, 20);
      const stroke = penStroke(uniqueId('move-group'), [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]);
      store.setElements([shape, stroke]);
      store.selectMultiple([shape.id, stroke.id]);
      store.groupSelectedElements();
      const groupId = store.getState().groups[0].id;

      store.moveGroup(groupId, 5, -3);

      const movedShape = store.getState().elements[0] as RectangleElement;
      const movedStroke = store.getState().elements[1] as PenStroke;
      expect(movedShape.x).toBe(15);
      expect(movedShape.y).toBe(17);
      expect('points' in movedShape).toBe(false);
      expect(movedStroke.points).toEqual([
        { x: 6, y: -1 },
        { x: 8, y: 1 },
      ]);
      expect((movedStroke as unknown as { x?: number }).x).toBeUndefined();
    });

    it('moveGroup leaves a partially shaped member untouched', () => {
      const partial = {
        id: uniqueId('move-group-partial'),
        type: 'rectangle',
        x: 10,
      } as unknown as CanvasElement;
      const shape = rectangle(uniqueId('move-group-partial'), 0, 0);
      store.setElements([partial, shape]);
      store.selectMultiple([partial.id, shape.id]);
      store.groupSelectedElements();
      const groupId = store.getState().groups[0].id;

      store.moveGroup(groupId, 5, 5);

      const movedPartial = store.getState().elements[0] as unknown as {
        x: number;
        y?: number;
      };
      expect(movedPartial.x).toBe(10);
      expect(movedPartial.y).toBeUndefined();
      expect((store.getState().elements[1] as RectangleElement).x).toBe(5);
    });

    it('moveGroup skips members that were removed and ignores unknown groups', () => {
      const removed = rectangle(uniqueId('move-group-skip'), 0, 0);
      const remaining = rectangle(uniqueId('move-group-skip'), 30, 30);
      store.setElements([removed, remaining]);
      store.selectMultiple([removed.id, remaining.id]);
      store.groupSelectedElements();
      const groupId = store.getState().groups[0].id;
      store.removeElement(removed.id);

      store.moveGroup(groupId, 5, 5);

      const moved = store.getState().elements[0] as RectangleElement;
      expect(moved.id).toBe(remaining.id);
      expect(moved.x).toBe(35);
      expect(moved.y).toBe(35);

      expect(notificationsFrom(() => store.moveGroup(uniqueId('move-group-skip'), 5, 5))).toBe(0);
    });
  });
});

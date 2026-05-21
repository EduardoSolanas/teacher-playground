import { describe, it, expect, beforeEach } from 'vitest';
import * as store from './store';
import {
  selectElement,
  toggleElementSelection,
  selectRectangle,
  deselectAll,
  getSelectedElements,
  moveSelectedElements,
  deleteSelectedElements,
  duplicateSelectedElements,
} from './selection';
import type { CanvasElement, RectangleElement, TextElement } from './types';
import type { Store } from './selection';

function resetStore() {
  store.setElements([]);
  store.deselectAll();
}

function createRectangle(id: string, x: number, y: number, w: number, h: number): RectangleElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    fill: '#f00',
    stroke: '#000',
    strokeWidth: 1,
  };
}

function createText(id: string, x: number, y: number, w: number, h: number, text: string): TextElement {
  return {
    id,
    type: 'text',
    x,
    y,
    width: w,
    height: h,
    text,
    color: '#000',
    fontSize: 16,
    fontFamily: 'Arial',
    bold: false,
    italic: false,
  };
}

const storeApi: Store = store;

describe('selection', () => {
  beforeEach(() => {
    resetStore();
  });

  it('single element selection', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 100, 0, 100, 50);
    store.addElement(el1);
    store.addElement(el2);

    selectElement(storeApi, '1');
    expect(store.getState().selectedIds).toEqual(['1']);
  });

  it('multi-element selection via rectangle', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 50, 0, 100, 50);
    const el3 = createRectangle('3', 200, 200, 100, 50);
    store.addElement(el1);
    store.addElement(el2);
    store.addElement(el3);

    selectRectangle(storeApi, 0, 0, 150, 100);

    const selected = getSelectedElements(storeApi);
    expect(selected.length).toBe(2);
    expect(selected.map((e) => e.id)).toContain('1');
    expect(selected.map((e) => e.id)).toContain('2');
  });

  it('Ctrl+click toggle selection', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 100, 0, 100, 50);
    const el3 = createRectangle('3', 200, 0, 100, 50);
    store.addElement(el1);
    store.addElement(el2);
    store.addElement(el3);

    selectElement(storeApi, '1');
    toggleElementSelection(storeApi, '2');
    expect(store.getState().selectedIds).toEqual(['1', '2']);

    toggleElementSelection(storeApi, '1');
    expect(store.getState().selectedIds).toEqual(['2']);

    toggleElementSelection(storeApi, '2');
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('deselect all', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 100, 0, 100, 50);
    store.addElement(el1);
    store.addElement(el2);

    selectElement(storeApi, '1');
    selectElement(storeApi, '2');
    expect(store.getState().selectedIds).toEqual(['2']);

    deselectAll(storeApi);
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('move selected elements', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 100, 0, 100, 50);
    store.addElement(el1);
    store.addElement(el2);

    store.selectMultiple(['1', '2']);

    moveSelectedElements(storeApi, 50, 30);

    const updated = store.getState().elements;
    const e1 = updated.find((e) => e.id === '1') as RectangleElement;
    const e2 = updated.find((e) => e.id === '2') as RectangleElement;
    expect(e1.x).toBe(50);
    expect(e1.y).toBe(30);
    expect(e2.x).toBe(150);
    expect(e2.y).toBe(30);
  });

  it('delete selected elements', () => {
    const el1 = createRectangle('1', 0, 0, 100, 50);
    const el2 = createRectangle('2', 100, 0, 100, 50);
    const el3 = createRectangle('3', 200, 0, 100, 50);
    store.addElement(el1);
    store.addElement(el2);
    store.addElement(el3);

    store.selectMultiple(['1', '2']);

    deleteSelectedElements(storeApi);

    expect(store.getState().elements.length).toBe(1);
    expect(store.getState().elements[0].id).toBe('3');
    expect(store.getState().selectedIds).toEqual([]);
  });

  it('duplicate selected elements', () => {
    const el1 = createRectangle('1', 10, 20, 100, 50);
    const el2 = createText('2', 30, 40, 80, 30, 'Hello');
    store.addElement(el1);
    store.addElement(el2);

    store.selectMultiple(['1', '2']);

    expect(store.getState().elements.length).toBe(2);

    duplicateSelectedElements(storeApi);

    expect(store.getState().elements.length).toBe(4);

    const newEls = store.getState().elements.filter((e) => e.id !== '1' && e.id !== '2');
    expect(newEls.length).toBe(2);

    const newRect = newEls.find((e) => e.type === 'rectangle') as RectangleElement | undefined;
    expect(newRect).toBeDefined();
    expect(newRect!.x).toBe(30);
    expect(newRect!.y).toBe(40);

    const newText = newEls.find((e) => e.type === 'text') as TextElement | undefined;
    expect(newText).toBeDefined();
    expect(newText!.x).toBe(50);
    expect(newText!.y).toBe(60);
    expect(newText!.text).toBe('Hello');
  });
});

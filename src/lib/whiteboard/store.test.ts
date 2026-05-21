import { describe, it, expect, beforeEach } from 'vitest';
import * as store from './store';
import type { CanvasElement } from './types';

function resetStore() {
  store.setElements([]);
  store.deselectAll();
  store.setTool('select');
}

describe('whiteboard store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('element is added to store', () => {
    const el: CanvasElement = {
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000000',
      strokeWidth: 2,
    };
    store.addElement(el);
    expect(store.getState().elements.length).toBe(1);
    expect(store.getState().elements[0]).toBe(el);
  });

  it('element is removed from store', () => {
    const el: CanvasElement = {
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000000',
      strokeWidth: 2,
    };
    store.addElement(el);
    store.removeElement('1');
    expect(store.getState().elements.length).toBe(0);
  });

  it('tool changes', () => {
    expect(store.getState().tool).toBe('select');
    store.setTool('pen');
    expect(store.getState().tool).toBe('pen');
  });

  it('viewport updates', () => {
    store.setViewport({ x: 100, y: 200, zoom: 2.0 });
    const vp = store.getState().viewport;
    expect(vp.x).toBe(100);
    expect(vp.y).toBe(200);
    expect(vp.zoom).toBe(2.0);
  });

  it('element can be moved', () => {
    const el: CanvasElement = {
      id: '1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      fill: '#f00',
      stroke: '#000',
      strokeWidth: 1,
    };
    store.addElement(el);
    store.moveElement('1', { x: 50, y: 100 });
    const updated = store.getState().elements[0] as typeof el;
    expect(updated.x).toBe(50);
    expect(updated.y).toBe(100);
  });

  it('element can be duplicated', () => {
    const el: CanvasElement = {
      id: '1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#f00',
      stroke: '#000',
      strokeWidth: 1,
    };
    store.addElement(el);
    store.duplicateElement('1');
    expect(store.getState().elements.length).toBe(2);
    const duplicated = store.getState().elements.find((e) => e.id !== '1');
    expect(duplicated).toBeDefined();
    expect(duplicated!.id).not.toBe('1');
    expect(store.getState().selectedIds).toContain(duplicated!.id);
  });

  it('currentElement state behaves correctly without history', () => {
    // 1. currentElement should default to null
    // @ts-ignore
    expect(store.getState().currentElement).toBeNull(); // It should be null initially

    const el: CanvasElement = {
      id: 'preview-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#f00',
      stroke: '#000',
      strokeWidth: 1,
    };
    
    const undoBefore = store.canUndo();
    const redoBefore = store.canRedo();

    // @ts-ignore
    store.setCurrentElement(el);
    // @ts-ignore
    expect(store.getState().currentElement).toBe(el);

    // Setting currentElement should NOT affect elements array
    expect(store.getState().elements.length).toBe(0);

    // Setting currentElement should NOT affect history
    expect(store.canUndo()).toBe(undoBefore);
    expect(store.canRedo()).toBe(redoBefore);

    // @ts-ignore
    store.setCurrentElement(null);
    // @ts-ignore
    expect(store.getState().currentElement).toBeNull();
  });
});

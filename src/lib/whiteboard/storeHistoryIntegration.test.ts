import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '@/lib/whiteboard/store';

describe('Store history integration', () => {
  beforeEach(() => {
    // Reset history manager to clean state
    const hm = store.getHistoryManager();
    (hm as any).past = [];
    (hm as any).future = [];
    store.setElements([]);
    store.deselectAll();
  });

  it('pushes history snapshot on addElement', () => {
    // After beforeEach: setElements([]) pushes [] to past -> past=[[]], canUndo=true
    expect(store.canUndo()).toBe(true);

    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    expect(store.canUndo()).toBe(true);
    expect(store.getState().elements).toHaveLength(1);
  });

  it('pushes history snapshot on updateElement', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    store.updateElement('1', { strokeWidth: 4 });

    expect(store.canUndo()).toBe(true);
    const el = store.getState().elements[0];
    // @ts-ignore
    expect(el.strokeWidth).toBe(4);
  });

  it('pushes history snapshot on removeElement', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    store.removeElement('1');

    expect(store.canUndo()).toBe(true);
    expect(store.getState().elements).toHaveLength(0);
  });

  it('pushes history snapshot on setElements', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    store.setElements([]);

    expect(store.canUndo()).toBe(true);
    expect(store.getState().elements).toHaveLength(0);
  });

  it('undo restores previous state', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    const beforeUndo = [...store.getState().elements];

    store.removeElement('1');
    expect(store.getState().elements).toHaveLength(0);

    store.undo();
    expect(store.getState().elements).toHaveLength(1);
    expect(store.getState().elements[0].id).toBe(beforeUndo[0].id);
  });

  it('redo restores undone state', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    store.removeElement('1');
    store.undo();
    expect(store.getState().elements).toHaveLength(1);

    store.redo();
    expect(store.getState().elements).toHaveLength(0);
  });

  it('new edit after undo clears future history', () => {
    store.addElement({
      id: '1',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    });

    store.addElement({
      id: '2',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 20, y: 20 }],
      color: '#f00',
      strokeWidth: 2,
    });

    store.undo(); // back to 1 element
    expect(store.canRedo()).toBe(true);

    store.addElement({
      id: '3',
      type: 'pen',
      points: [{ x: 0, y: 0 }, { x: 30, y: 30 }],
      color: '#0f0',
      strokeWidth: 2,
    });

    expect(store.canRedo()).toBe(false);
  });
});

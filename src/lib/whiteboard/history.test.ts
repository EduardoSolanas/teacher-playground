import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryManager } from './history';
import type { CanvasElement, RectangleElement } from '@/types/whiteboard';

function createRect(id: string, x: number, y: number): RectangleElement {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 50,
    fill: '#f00',
    stroke: '#000',
    strokeWidth: 1,
  };
}

describe('history', () => {
  let history: HistoryManager;

  beforeEach(() => {
    history = new HistoryManager();
  });

  it('history push on element add', () => {
    const elements = [createRect('1', 0, 0)];
    history.push(elements);

    // After one push, can undo
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    history.push(elements);
    expect(history.canUndo()).toBe(true);
  });

  it('undo pops last entry and returns previous', () => {
    const elements1 = [createRect('1', 0, 0)];
    const elements2 = [createRect('1', 0, 0), createRect('2', 100, 0)];

    history.push(elements1);
    history.push(elements2);

    // past = [elements1, elements2]
    // undo: pop elements2, return elements1
    const result = history.undo();
    expect(result).toEqual(elements1);
    // past = [elements1], canUndo = true (1 > 0)
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(true);
  });

  it('redo re-applies undone entry', () => {
    const elements1 = [createRect('1', 0, 0)];
    const elements2 = [createRect('1', 0, 0), createRect('2', 100, 0)];

    history.push(elements1);
    history.push(elements2);

    history.undo(); // past=[elements1], future=[elements1], returned elements1
    expect(history.canUndo()).toBe(true);

    const result = history.redo();
    expect(result).toEqual(elements2);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  it('history cap at 50 entries', () => {
    history.maxSize = 5;
    const base = [createRect('base', 0, 0)];
    for (let i = 0; i < 10; i++) {
      history.push(base);
    }

    expect(history.canUndo()).toBe(true);
    expect(history['past'].length).toBe(5);

    const result = history.undo();
    expect(result).toBeDefined();
  });

  it('new edit clears future history', () => {
    const elements1 = [createRect('1', 0, 0)];
    const elements2 = [createRect('1', 0, 0), createRect('2', 100, 0)];
    const elements3 = [createRect('1', 0, 0), createRect('2', 100, 0), createRect('3', 200, 0)];

    history.push(elements1);
    history.push(elements2);
    history.undo(); // past=[elements1], future=[elements1]

    expect(history.canRedo()).toBe(true);

    history.push(elements3); // clears future

    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });

  it('cannot undo when no history', () => {
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it('cannot redo when no future', () => {
    history.push([createRect('1', 0, 0)]);
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBeNull();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import * as store from '@/lib/whiteboard/store';
import type { CanvasElement } from '@/types/whiteboard';
import { pushHistory, useUndoRedo } from './useUndoRedo';

const ELEMENT = {
  id: 'undo-redo-1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fill: '#fff',
  stroke: '#000',
  strokeWidth: 1,
} as CanvasElement;

describe('useUndoRedo', () => {
  afterEach(() => {
    act(() => {
      store.setElements([]);
      store.deselectAll();
    });
  });

  it('leaves undo and redo as no-ops before any snapshot exists', () => {
    const { result } = renderHook(() => useUndoRedo());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    act(() => {
      result.current.undo();
      result.current.redo();
    });

    expect(store.getState().elements).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('undoes to the previous snapshot and redoes back to it', () => {
    const { result } = renderHook(() => useUndoRedo());

    act(() => {
      store.setElements([ELEMENT]);
      pushHistory();
      store.deselectAll();
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => {
      result.current.undo();
    });
    expect(store.getState().elements).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.redo();
    });
    expect(store.getState().elements).toEqual([ELEMENT]);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('tracks the live store elements across external updates', () => {
    const { result } = renderHook(() => useUndoRedo());

    act(() => {
      store.setElements([ELEMENT]);
    });

    expect(result.current.elements).toEqual([ELEMENT]);
  });
});

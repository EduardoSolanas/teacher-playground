import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as store from '@/lib/whiteboard/store';
import type { CanvasElement } from '@/types/whiteboard';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const ELEMENT = {
  id: 'rect-1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  fill: '#fff',
  stroke: '#000',
  strokeWidth: 1,
} as CanvasElement;

function pressKey(target: EventTarget, key: string) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

describe('useKeyboardShortcuts input guard (UX-A1)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    store.setElements([]);
    store.deselectAll();
  });

  it('does not delete a selected element when Backspace is typed in an input', () => {
    store.setElements([ELEMENT]);
    store.selectElement(ELEMENT.id);
    renderHook(() => useKeyboardShortcuts());

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    pressKey(input, 'Backspace');

    expect(store.getState().elements).toHaveLength(1);
  });

  it('deletes a selected element when Backspace is pressed on the page', () => {
    store.setElements([ELEMENT]);
    store.selectElement(ELEMENT.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'Backspace');

    expect(store.getState().elements).toHaveLength(0);
  });
});

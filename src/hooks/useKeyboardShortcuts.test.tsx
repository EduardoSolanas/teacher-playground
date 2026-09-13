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

function makeElement(id: string): CanvasElement {
  return { ...ELEMENT, id } as CanvasElement;
}

function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

function resetStore() {
  document.body.innerHTML = '';
  store.setElements([]);
  store.deselectAll();
  store.setTool('select');
}

describe('useKeyboardShortcuts input guard (UX-A1)', () => {
  afterEach(resetStore);

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

describe('useKeyboardShortcuts editing keys', () => {
  afterEach(resetStore);

  it('Escape clears the selection and returns to the select tool', () => {
    const element = makeElement('esc-1');
    store.setElements([element]);
    store.selectElement(element.id);
    store.setTool('pen');
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'Escape');

    expect(store.getState().selectedIds).toEqual([]);
    expect(store.getState().tool).toBe('select');
  });

  it('Delete removes the selected element', () => {
    const element = makeElement('del-1');
    store.setElements([element]);
    store.selectElement(element.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'Delete');

    expect(store.getState().elements).toEqual([]);
  });

  it('ignores Delete when nothing is selected', () => {
    const element = makeElement('del-2');
    store.setElements([element]);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'Delete');

    expect(store.getState().elements).toEqual([element]);
  });

  it('Ctrl+D and Meta+D duplicate the selected element', () => {
    const element = makeElement('dup-1');
    store.setElements([element]);
    store.selectElement(element.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'd', { ctrlKey: true });
    expect(store.getState().elements).toHaveLength(2);
    expect((store.getState().elements[1] as { x: number }).x).toBe(
      (element as { x: number }).x + 20,
    );

    pressKey(document.body, 'd', { metaKey: true });
    expect(store.getState().elements).toHaveLength(3);
  });

  it('Ctrl+G groups the selection and Ctrl+Shift+G ungroups it', () => {
    const first = makeElement('grp-a');
    const second = makeElement('grp-b');
    store.setElements([first, second]);
    store.selectMultiple([first.id, second.id]);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'G', { ctrlKey: true });
    expect(store.getGroupForElement(first.id)).toBeDefined();

    pressKey(document.body, 'G', { ctrlKey: true, shiftKey: true });
    expect(store.getGroupForElement(first.id)).toBeUndefined();
  });

  it('Ctrl+Shift+G leaves an ungrouped selection alone', () => {
    const element = makeElement('grp-c');
    store.setElements([element]);
    store.selectElement(element.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'g', { ctrlKey: true, shiftKey: true });

    expect(store.getState().elements).toEqual([element]);
  });

  it('Ctrl+] and Ctrl+Shift+] move one selected element forward', () => {
    const first = makeElement('ord-a');
    const second = makeElement('ord-b');
    const third = makeElement('ord-c');
    store.setElements([first, second, third]);
    store.selectElement(first.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, ']', { ctrlKey: true });
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);

    pressKey(document.body, ']', { ctrlKey: true, shiftKey: true });
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
  });

  it('Ctrl+[ and Ctrl+Shift+[ move one selected element backward', () => {
    const first = makeElement('ord-d');
    const second = makeElement('ord-e');
    const third = makeElement('ord-f');
    store.setElements([first, second, third]);
    store.selectElement(third.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, '[', { ctrlKey: true });
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      third.id,
      second.id,
    ]);

    pressKey(document.body, '[', { ctrlKey: true, shiftKey: true });
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
  });

  it('ordering shortcuts ignore zero or multiple selected elements', () => {
    const first = makeElement('ord-g');
    const second = makeElement('ord-h');
    store.setElements([first, second]);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, ']', { ctrlKey: true });
    pressKey(document.body, '[', { ctrlKey: true });
    pressKey(document.body, ']', { ctrlKey: true, shiftKey: true });
    pressKey(document.body, '[', { ctrlKey: true, shiftKey: true });
    pressKey(document.body, 'g', { ctrlKey: true, shiftKey: true });

    store.selectMultiple([first.id, second.id]);
    pressKey(document.body, ']', { ctrlKey: true });
    pressKey(document.body, '[', { ctrlKey: true });
    pressKey(document.body, ']', { ctrlKey: true, shiftKey: true });
    pressKey(document.body, '[', { ctrlKey: true, shiftKey: true });

    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it('ignores unmodified keys and modifier chords without a binding', () => {
    const element = makeElement('noop-1');
    store.setElements([element]);
    store.selectElement(element.id);
    renderHook(() => useKeyboardShortcuts());

    pressKey(document.body, 'a');
    pressKey(document.body, 'x', { ctrlKey: true });
    pressKey(document.body, 'Shift');

    expect(store.getState().elements).toEqual([element]);
  });
});

describe('useKeyboardShortcuts help-sheet actions', () => {
  afterEach(resetStore);

  it('runs every listed action against the real store', () => {
    const { result } = renderHook(() => useKeyboardShortcuts());
    const actionFor = (label: string) => {
      const shortcut = result.current.activeShortcuts.find((entry) => entry.label === label);
      if (!shortcut) throw new Error(`missing shortcut: ${label}`);
      return shortcut.action;
    };

    const first = makeElement('act-a');
    const second = makeElement('act-b');
    const third = makeElement('act-c');
    store.setElements([first, second, third]);

    store.selectMultiple([first.id, second.id]);
    actionFor('Group (Ctrl+G)')();
    expect(store.getGroupForElement(first.id)).toBeDefined();
    actionFor('Ungroup (Ctrl+Shift+G)')();
    expect(store.getGroupForElement(first.id)).toBeUndefined();

    store.selectElement(first.id);
    actionFor('Bring Forward (Ctrl+])')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      second.id,
      first.id,
      third.id,
    ]);

    actionFor('Send Backward (Ctrl+[)')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    actionFor('Bring to Front (Ctrl+Shift+])')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);

    actionFor('Send to Back (Ctrl+Shift+[)')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    store.deselectAll();
    actionFor('Bring Forward (Ctrl+])')();
    actionFor('Send Backward (Ctrl+[)')();
    actionFor('Bring to Front (Ctrl+Shift+])')();
    actionFor('Send to Back (Ctrl+Shift+[)')();
    actionFor('Ungroup (Ctrl+Shift+G)')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);

    store.selectElement(third.id);
    actionFor('Ungroup (Ctrl+Shift+G)')();
    expect(store.getGroupForElement(third.id)).toBeUndefined();

    actionFor('Delete Selected')();
    expect(store.getState().elements.map((element) => element.id)).toEqual([
      first.id,
      second.id,
    ]);

    store.selectElement(first.id);
    actionFor('Duplicate Selected (Ctrl+D)')();
    expect(store.getState().elements).toHaveLength(3);

    store.setTool('rectangle');
    actionFor('Deselect / Select Tool')();
    expect(store.getState().tool).toBe('select');
    expect(store.getState().selectedIds).toEqual([]);

    actionFor('Undo (Ctrl+Z)')();
    actionFor('Redo (Ctrl+Shift+Z)')();
    actionFor('Redo (Ctrl+Y)')();
    actionFor('Toggle Shortcuts Help')();
  });
});

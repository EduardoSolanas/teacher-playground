import { useState, useCallback, useEffect, useRef } from 'react';
import * as store from '@/lib/whiteboard/store';
import { pushHistory } from './useUndoRedo';
import { getSelectedElements, deleteSelectedElements, duplicateSelectedElements } from '@/lib/whiteboard/selection';
import type { ToolType } from '@/types/whiteboard';

const SHORTCUTS: Array<{ key: string; label: string; action: () => void; ctrl?: boolean; shift?: boolean }> = [
  {
    key: 'delete',
    label: 'Delete Selected',
    action: () => { deleteSelectedElements(store); pushHistory(); },
  },
  {
    key: 'backspace',
    label: 'Delete Selected',
    action: () => { deleteSelectedElements(store); pushHistory(); },
  },
  {
    key: 'd',
    label: 'Duplicate Selected (Ctrl+D)',
    action: () => { duplicateSelectedElements(store); pushHistory(); },
    ctrl: true,
  },
  {
    key: 'z',
    label: 'Undo (Ctrl+Z)',
    action: () => {},
    ctrl: true,
  },
  {
    key: 'z',
    label: 'Redo (Ctrl+Shift+Z)',
    action: () => {},
    ctrl: true,
    shift: true,
  },
  {
    key: 'y',
    label: 'Redo (Ctrl+Y)',
    action: () => {},
    ctrl: true,
  },
  {
    key: 'g',
    label: 'Group (Ctrl+G)',
    action: () => { store.groupSelectedElements(); pushHistory(); },
    ctrl: true,
  },
  {
    key: 'g',
    label: 'Ungroup (Ctrl+Shift+G)',
    action: () => {
      const selected = getSelectedElements(store);
      if (selected.length > 0) {
        const group = store.getGroupForElement(selected[0].id);
        if (group) {
          store.ungroup(group.id);
          pushHistory();
        }
      }
    },
    ctrl: true,
    shift: true,
  },
  {
    key: ']',
    label: 'Bring Forward (Ctrl+])',
    action: () => {
      const selected = getSelectedElements(store);
      if (selected.length === 1) {
        store.bringForward(selected[0].id);
      }
    },
    ctrl: true,
  },
  {
    key: '[',
    label: 'Send Backward (Ctrl+[)',
    action: () => {
      const selected = getSelectedElements(store);
      if (selected.length === 1) {
        store.sendBackward(selected[0].id);
      }
    },
    ctrl: true,
  },
  {
    key: ']',
    label: 'Bring to Front (Ctrl+Shift+])',
    action: () => {
      const selected = getSelectedElements(store);
      if (selected.length === 1) {
        store.bringToFront(selected[0].id);
      }
    },
    ctrl: true,
    shift: true,
  },
  {
    key: '[',
    label: 'Send to Back (Ctrl+Shift+[)',
    action: () => {
      const selected = getSelectedElements(store);
      if (selected.length === 1) {
        store.sendToBack(selected[0].id);
      }
    },
    ctrl: true,
    shift: true,
  },
  {
    key: 'escape',
    label: 'Deselect / Select Tool',
    action: () => { store.deselectAll(); store.setTool('select'); },
  },
  {
    key: '?',
    label: 'Toggle Shortcuts Help',
    action: () => {},
  },
];

export function useKeyboardShortcuts() {
  const shown = useRef(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      /*
       * "?" is not this hook's any more. It used to toggle a sheet of
       * accelerators; the only "?" in the room now is the support button, and
       * swallowing the key here would have stopped anybody typing one.
       */
      if (e.key === 'Escape') {
        e.preventDefault();
        store.deselectAll();
        store.setTool('select');
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = getSelectedElements(store);
        if (selected.length > 0 && !shown.current) {
          e.preventDefault();
          deleteSelectedElements(store);
          pushHistory();
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        /*
         * Undo and redo are Excalidraw's, keyboard included.
         *
         * This used to catch Ctrl+Z first and call preventDefault, which meant
         * that whichever undo the room decided to show, the keyboard reached
         * the other one -- and once the buttons were Excalidraw's, the
         * accelerator would have gone on driving a stack nothing was showing.
         * They are still listed in the help sheet: the shortcut works, it is
         * simply not this hook that answers it.
         */
        if (key === 'd') {
          e.preventDefault();
          duplicateSelectedElements(store);
          pushHistory();
          return;
        }
        if (key === 'g') {
          e.preventDefault();
          if (e.shiftKey) {
            const selected = getSelectedElements(store);
            if (selected.length > 0) {
              const group = store.getGroupForElement(selected[0].id);
              if (group) {
                store.ungroup(group.id);
                pushHistory();
              }
            }
          } else {
            store.groupSelectedElements();
            pushHistory();
          }
          return;
        }
        if (key === ']') {
          e.preventDefault();
          if (e.shiftKey) {
            const selected = getSelectedElements(store);
            if (selected.length === 1) store.bringToFront(selected[0].id);
          } else {
            const selected = getSelectedElements(store);
            if (selected.length === 1) store.bringForward(selected[0].id);
          }
          return;
        }
        if (key === '[') {
          e.preventDefault();
          if (e.shiftKey) {
            const selected = getSelectedElements(store);
            if (selected.length === 1) store.sendToBack(selected[0].id);
          } else {
            const selected = getSelectedElements(store);
            if (selected.length === 1) store.sendBackward(selected[0].id);
          }
          return;
        }
      }

      /*
       * Choosing a tool is Excalidraw's, keyboard included.
       *
       * This mapped v/p/t/r/c/l/a/s/e onto the store and called preventDefault
       * in the capture phase, which beat Excalidraw to its own keys. With the
       * toolbar now theirs, that would have left two sets of letters for one
       * row of buttons -- and the pair that did not match (C for circle where
       * they use O for ellipse, S for a sticky note that was only ever a
       * rectangle) would have been the confusing half.
       */
    }

    // Capture phase: once the Excalidraw canvas has focus (i.e. after drawing)
    // it consumes keys it recognises, which silently killed these shortcuts.
    // Text entry is still respected via the INPUT/TEXTAREA guard above.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return { activeShortcuts: SHORTCUTS };
}

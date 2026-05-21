import { useState, useCallback, useEffect, useRef } from 'react';
import * as store from '@/lib/whiteboard/store';
import { useUndoRedo } from './useUndoRedo';
import { pushHistory } from './useUndoRedo';
import { getSelectedElements, deleteSelectedElements, duplicateSelectedElements } from '@/lib/whiteboard/selection';
import type { ToolType } from '@/types/whiteboard';

const SHORTCUTS: Array<{ key: string; label: string; action: () => void; ctrl?: boolean; shift?: boolean }> = [
  { key: 'v', label: 'Select Tool (V)', action: () => store.setTool('select') },
  { key: 'p', label: 'Pen Tool (P)', action: () => store.setTool('pen') },
  { key: 't', label: 'Text Tool (T)', action: () => store.setTool('text') },
  { key: 'r', label: 'Rectangle Tool (R)', action: () => store.setTool('rectangle') },
  { key: 'c', label: 'Circle Tool (C)', action: () => store.setTool('circle') },
  { key: 'l', label: 'Line Tool (L)', action: () => store.setTool('line') },
  { key: 'a', label: 'Arrow Tool (A)', action: () => store.setTool('arrow') },
  { key: 's', label: 'Sticky Note Tool (S)', action: () => store.setTool('stickyNote') },
  { key: 'e', label: 'Eraser Tool (E)', action: () => store.setTool('eraser') },
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
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const { undo, redo } = useUndoRedo();
  const shown = useRef(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcutsHelp((prev) => !prev);
        return;
      }

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
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          redo();
          return;
        }
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

      const toolMap: Record<string, ToolType> = {
        v: 'select',
        p: 'pen',
        t: 'text',
        r: 'rectangle',
        c: 'circle',
        l: 'line',
        a: 'arrow',
        s: 'stickyNote',
        e: 'eraser',
      };

      const key = e.key.toLowerCase();
      if (toolMap[key] && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).contentEditable === 'true')) {
          return;
        }
        e.preventDefault();
        store.setTool(toolMap[key]);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return { activeShortcuts: SHORTCUTS, showShortcutsHelp, setShowShortcutsHelp };
}

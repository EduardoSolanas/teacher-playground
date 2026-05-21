import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as store from '@/lib/whiteboard/store';
import { getSelectedElements } from '@/lib/whiteboard/selection';
import type { CanvasElement } from '@/types/whiteboard';
import { pushHistory } from '@/hooks/useUndoRedo';

interface ContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  onAddText: () => void;
  onAddStickyNote: () => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
}

export default function ContextMenu({
  visible,
  x,
  y,
}: {
  visible: boolean;
  x: number;
  y: number;
}) {
  const [menuState, setMenuState] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    hasSelection: false,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible) {
      const selected = getSelectedElements(store);
      setMenuState({ visible: true, x, y, hasSelection: selected.length > 0 });
    } else {
      setMenuState((prev) => ({ ...prev, visible: false }));
    }
  }, [visible, x, y]);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setMenuState((prev) => ({ ...prev, visible: false }));
    }
  }, []);

  useEffect(() => {
    if (menuState.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [menuState.visible, handleClickOutside]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuState((prev) => ({ ...prev, visible: false }));
      }
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  if (!menuState.visible) return null;

  const handleAction = (action: string) => {
    setMenuState((prev) => ({ ...prev, visible: false }));

    switch (action) {
      case 'delete': {
        const selected = getSelectedElements(store);
        selected.forEach((el) => store.removeElement(el.id));
        store.deselectAll();
        pushHistory();
        break;
      }
      case 'duplicate': {
        const selected = getSelectedElements(store);
        for (const el of selected) {
          const newEl: CanvasElement = {
            ...el,
            id: Math.random().toString(36).slice(2),
          };
          if ('x' in el && 'y' in el) {
            (newEl as any).x = (el as any).x + 20;
            (newEl as any).y = (el as any).y + 20;
          }
          if ('points' in el) {
            (newEl as any).points = (el as any).points.map((p: { x: number; y: number }) => ({
              x: p.x + 20,
              y: p.y + 20,
            }));
          }
          store.addElement(newEl);
        }
        pushHistory();
        break;
      }
      case 'bringForward': {
        const selected = getSelectedElements(store);
        if (selected.length === 1) {
          store.bringForward(selected[0].id);
        }
        break;
      }
      case 'sendBackward': {
        const selected = getSelectedElements(store);
        if (selected.length === 1) {
          store.sendBackward(selected[0].id);
        }
        break;
      }
      case 'bringToFront': {
        const selected = getSelectedElements(store);
        if (selected.length === 1) {
          store.bringToFront(selected[0].id);
        }
        break;
      }
      case 'sendToBack': {
        const selected = getSelectedElements(store);
        if (selected.length === 1) {
          store.sendToBack(selected[0].id);
        }
        break;
      }
      case 'addText': {
        store.setTool('text');
        break;
      }
      case 'addStickyNote': {
        store.setTool('stickyNote');
        break;
      }
    }
  };

  const itemClasses = "flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-slate-700";

  return (
    <div ref={menuRef} className="fixed bg-slate-800 border border-slate-700 rounded-lg p-1 z-[10000] min-w-[180px] shadow-xl" style={{ left: menuState.x, top: menuState.y }}>
      {menuState.hasSelection ? (
        <>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('delete')}
          >
            Delete
          </button>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('duplicate')}
          >
            Duplicate
          </button>
          <div className="h-px bg-slate-700 my-1" />
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('bringForward')}
          >
            Bring Forward
          </button>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('sendBackward')}
          >
            Send Backward
          </button>
          <div className="h-px bg-slate-700 my-1" />
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('bringToFront')}
          >
            Bring to Front
          </button>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('sendToBack')}
          >
            Send to Back
          </button>
        </>
      ) : (
        <>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('addText')}
          >
            Add Text
          </button>
          <button
            className={itemClasses}
            style={{ color: '#e5e7eb' }}
            onClick={() => handleAction('addStickyNote')}
          >
            Add Sticky Note
          </button>
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import * as store from '@/lib/whiteboard/store';

export function useWhiteboardStore() {
  const [state, setState] = useState(store.getState());
  const [canUndo, setCanUndo] = useState(store.canUndo());
  const [canRedo, setCanRedo] = useState(store.canRedo());

  useEffect(() => {
    return store.subscribe(() => {
      const s = store.getState();
      setState({ ...s });
      setCanUndo(store.canUndo());
      setCanRedo(store.canRedo());
    });
  }, []);

  return {
    ...state,
    addElement: store.addElement,
    updateElement: store.updateElement,
    removeElement: store.removeElement,
    selectElement: store.selectElement,
    selectMultiple: store.selectMultiple,
    deselectAll: store.deselectAll,
    setTool: store.setTool,
    setPalette: store.setPalette,
    setViewport: store.setViewport,
    setElements: store.setElements,
    moveElement: store.moveElement,
    duplicateElement: store.duplicateElement,
    bringForward: store.bringForward,
    sendBackward: store.sendBackward,
    bringToFront: store.bringToFront,
    sendToBack: store.sendToBack,
    undo: store.undo,
    redo: store.redo,
    canUndo,
    canRedo,
    pushHistorySnapshot: store.pushHistorySnapshot,
    setCurrentElement: store.setCurrentElement,
  };
}

export function useWhiteboardStoreDerived() {
  const [state, setState] = useState(store.getState());
  const [canUndo, setCanUndo] = useState(store.canUndo());
  const [canRedo, setCanRedo] = useState(store.canRedo());

  useEffect(() => {
    return store.subscribe(() => {
      const s = store.getState();
      setState({ ...s });
      setCanUndo(store.canUndo());
      setCanRedo(store.canRedo());
    });
  }, []);

  return {
    ...state,
    addElement: store.addElement,
    updateElement: store.updateElement,
    removeElement: store.removeElement,
    selectElement: store.selectElement,
    selectMultiple: store.selectMultiple,
    deselectAll: store.deselectAll,
    setTool: store.setTool,
    setPalette: store.setPalette,
    setViewport: store.setViewport,
    setElements: store.setElements,
    moveElement: store.moveElement,
    duplicateElement: store.duplicateElement,
    bringForward: store.bringForward,
    sendBackward: store.sendBackward,
    bringToFront: store.bringToFront,
    sendToBack: store.sendToBack,
    undo: store.undo,
    redo: store.redo,
    canUndo,
    canRedo,
    pushHistorySnapshot: store.pushHistorySnapshot,
    setCurrentElement: store.setCurrentElement,
  };
}

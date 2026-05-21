import { useEffect, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { getElementsFromArray } from '@/lib/whiteboard/yjsDoc';
import type { CanvasElement } from '@/types/whiteboard';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function useYjsSync(
  elementsArray: Y.Array<Y.Map<any>> | null,
  setElements: (elements: CanvasElement[]) => void
) {
  const setElementsRef = useRef(setElements);
  setElementsRef.current = setElements;

  const debouncedSync = useCallback((elements: CanvasElement[]) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      setElementsRef.current(elements);
      debounceTimer = null;
    }, 100);
  }, []);

  useEffect(() => {
    if (!elementsArray) return;

    const handleChange = () => {
      const elements = getElementsFromArray(elementsArray);
      debouncedSync(elements);
    };

    elementsArray.observe(handleChange);

    const initialElements = getElementsFromArray(elementsArray);
    if (initialElements.length > 0) {
      debouncedSync(initialElements);
    }

    return () => {
      elementsArray.unobserve(handleChange);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [elementsArray, debouncedSync]);
}

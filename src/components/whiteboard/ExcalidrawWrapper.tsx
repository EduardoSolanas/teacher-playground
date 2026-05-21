'use client';

import { useCallback, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';

type ExcalidrawWrapperProps = {
  elements: any[];
  viewport: { x: number; y: number; zoom: number };
  onElementsChange: (elements: any[]) => void;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  userName: string;
};

export default function ExcalidrawWrapper(_props: ExcalidrawWrapperProps) {
  const apiRef = useRef<any>(null);

  const handleAPI = useCallback((api: any) => {
    apiRef.current = api;
  }, []);

  return (
    <div className="w-full h-full min-h-[400px]">
      <Excalidraw
        excalidrawAPI={handleAPI}
        onChange={(...args: any[]) => {
          // Excalidraw handles its own state
        }}
        UIOptions={{
          canvasActions: {
            export: false,
            saveToActiveFile: false,
            loadScene: false,
            clearCanvas: false,
          },
        }}
        isCollaborating={false}
      />
    </div>
  );
}

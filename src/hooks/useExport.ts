import { useState, useCallback, useRef } from 'react';
import type { CanvasElement, Viewport } from '@/types/whiteboard';

interface ExportState {
  showMenu: boolean;
  scale: 1 | 2 | 4;
  exporting: boolean;
}

export function useExport() {
  const [state, setState] = useState<ExportState>({
    showMenu: false,
    scale: 1,
    exporting: false,
  });

  const stageRef = useRef<any>(null);

  const toggleMenu = useCallback(() => {
    setState((prev) => ({ ...prev, showMenu: !prev.showMenu }));
  }, []);

  const setScale = useCallback((scale: 1 | 2 | 4) => {
    setState((prev) => ({ ...prev, scale }));
  }, []);

  const exportAsPNG = useCallback(async () => {
    if (!stageRef.current || state.exporting) return;
    setState((prev) => ({ ...prev, exporting: true }));

    try {
      const { exportCanvasToPNG, downloadBlob } = await import(
        '@/lib/whiteboard/export'
      );
      const blob = await exportCanvasToPNG(stageRef.current, {
        scale: state.scale,
        filename: 'whiteboard.png',
      });
      downloadBlob(blob, 'whiteboard.png');
    } catch (error) {
      console.error('Failed to export PNG:', error);
    } finally {
      setState((prev) => ({ ...prev, exporting: false }));
    }
  }, [state.scale, state.exporting]);

  const exportAsSVG = useCallback(async () => {
    if (!stageRef.current || state.exporting) return;
    setState((prev) => ({ ...prev, exporting: true }));

    try {
      const { exportCanvasToSVG, downloadBlob } = await import(
        '@/lib/whiteboard/export'
      );
      const svgString = await exportCanvasToSVG(stageRef.current);
      const blob = new Blob([svgString], { type: 'image/svg+xml' });
      downloadBlob(blob, 'whiteboard.svg');
    } catch (error) {
      console.error('Failed to export SVG:', error);
    } finally {
      setState((prev) => ({ ...prev, exporting: false }));
    }
  }, [state.scale, state.exporting]);

  const setStageRef = useCallback((ref: any) => {
    stageRef.current = ref;
  }, []);

  return {
    ...state,
    toggleMenu,
    setScale,
    exportAsPNG,
    exportAsSVG,
    setStageRef,
  };
}

import React, { useCallback, useEffect } from 'react';
import WhiteboardCanvas from './WhiteboardCanvas';
import ToolSidebar from './ToolSidebar';
import PaletteBar from './PaletteBar';
import PenTool from './tools/PenTool';
import EraserTool from './tools/EraserTool';
import TextTool from './tools/TextTool';
import RectangleTool from './tools/RectangleTool';
import CircleTool from './tools/CircleTool';
import LineTool from './tools/LineTool';
import ArrowTool from './tools/ArrowTool';
import StickyNoteTool from './tools/StickyNoteTool';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { TOOL_SHORTCUTS } from '@/lib/whiteboard/constants';

export default function WhiteboardPage() {
  const { setTool, tool } = useWhiteboardStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const shortcut = Object.entries(TOOL_SHORTCUTS).find(
        ([, key]) => key.toLowerCase() === e.key.toLowerCase()
      );
      if (shortcut) {
        setTool(shortcut[0] as any);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setTool]);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        background: '#f8fafc',
      }}
    >
      <ToolSidebar />
      <PaletteBar />
      <div
        style={{
          position: 'absolute',
          left: 56,
          top: 48,
          width: 'calc(100vw - 56px)',
          height: 'calc(100vh - 48px)',
        }}
      >
        <WhiteboardCanvas setCursor={() => {}} userName="" />
        <PenTool />
        <EraserTool />
        <TextTool />
        <RectangleTool />
        <CircleTool />
        <LineTool />
        <ArrowTool />
        <StickyNoteTool />
      </div>
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import * as store from '@/lib/whiteboard/store';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import { STICKY_NOTE_COLORS } from '@/lib/whiteboard/constants';
import { getCanvasPointer } from './pointer';

export default function StickyNoteTool() {
  const { addElement, viewport, tool } = useWhiteboardStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editPosition, setEditPosition] = useState({ x: 0, y: 0 });
  const [editBg, setEditBg] = useState('#fff9c4');

  useEffect(() => {
    if (tool !== 'stickyNote') return;

    const onClick = (e: any) => {
      const pos = getCanvasPointer(e, viewport);
      const colorIndex = Math.floor(Math.random() * STICKY_NOTE_COLORS.length);
      addElement({
        id: uuidv4(),
        type: 'stickyNote',
        x: pos.x, y: pos.y,
        width: 180, height: 180,
        content: '',
        backgroundColor: STICKY_NOTE_COLORS[colorIndex],
        borderColor: '#333', borderRadius: 8,
      });
    };

    registerToolHandlers({ toolType: 'stickyNote', onClick });

    return () => {
      clearToolHandlers();
    };
  }, [tool, viewport, addElement]);

  const handleEditSave = useCallback(() => {
    if (editingId) {
      store.updateElement(editingId, { content: editContent, backgroundColor: editBg });
      setEditingId(null);
      setEditContent('');
    }
  }, [editingId, editContent, editBg]);

  const renderEditOverlay = editingId && (
    <div
      style={{
        position: 'fixed',
        left: editPosition.x * viewport.zoom + viewport.x,
        top: editPosition.y * viewport.zoom + viewport.y,
        zIndex: 1000,
      }}
    >
      <textarea
        autoFocus
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        onBlur={handleEditSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) handleEditSave();
          if (e.key === 'Escape') setEditingId(null);
        }}
        style={{
          width: 180, minHeight: 180, fontSize: 14, fontFamily: 'Arial',
          color: '#333', border: '2px solid #333', outline: 'none',
          padding: '8px', background: editBg, resize: 'none', borderRadius: 8,
        }}
      />
    </div>
  );

  if (tool !== 'stickyNote') return null;
  return <>{renderEditOverlay}</>;
}

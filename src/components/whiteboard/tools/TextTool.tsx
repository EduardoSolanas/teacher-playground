import { useEffect, useRef, useCallback, useState } from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { registerToolHandlers, clearToolHandlers } from '../ToolEvents';
import { uuidv4 } from '@/lib/uuid';
import * as store from '@/lib/whiteboard/store';
import { getCanvasPointer } from './pointer';

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];
const FONT_FAMILIES = [
  { label: 'Arial', value: 'Arial' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Courier New', value: 'Courier New' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Verdana', value: 'Verdana' },
];

const COLORS = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280',
];

export default function TextTool() {
  const { addElement, palette, viewport, tool } = useWhiteboardStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editPosition, setEditPosition] = useState({ x: 0, y: 0 });
  const [editFontSize, setEditFontSize] = useState(16);
  const [editFontFamily, setEditFontFamily] = useState('Arial');
  const [editColor, setEditColor] = useState('#000000');
  const [editBold, setEditBold] = useState(false);
  const [editItalic, setEditItalic] = useState(false);
  const [editUnderline, setEditUnderline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (tool !== 'text') return;

    const onClick = (e: any) => {
      const pos = getCanvasPointer(e, viewport);
      const id = uuidv4();
      addElement({
        id,
        type: 'text',
        x: pos.x, y: pos.y,
        width: 200, height: 30,
        text: '',
        color: palette.color,
        fontSize: 16,
        fontFamily: 'Arial',
        bold: false, italic: false, underline: false,
      });
      setEditingId(id);
      setEditText('');
      setEditPosition({ x: pos.x, y: pos.y });
      setEditFontSize(16);
      setEditFontFamily('Arial');
      setEditColor(palette.color);
      setEditBold(false);
      setEditItalic(false);
      setEditUnderline(false);
    };

    registerToolHandlers({ toolType: 'text', onClick });

    return () => {
      clearToolHandlers();
    };
  }, [tool, palette, viewport, addElement]);

  const handleEditSave = useCallback(() => {
    if (editingId) {
      store.updateElement(editingId, {
        text: editText,
        fontSize: editFontSize,
        fontFamily: editFontFamily,
        color: editColor,
        bold: editBold,
        italic: editItalic,
        underline: editUnderline,
      });
      setEditingId(null);
      setEditText('');
    }
  }, [editingId, editText, editFontSize, editFontFamily, editColor, editBold, editItalic, editUnderline]);

  const handleDismiss = useCallback(() => {
    if (editingId && editText.trim()) {
      handleEditSave();
    } else {
      store.removeElement(editingId!);
      setEditingId(null);
      setEditText('');
    }
  }, [editingId, editText, handleEditSave]);

  const handleTextareaKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleDismiss();
    }
  }, [handleDismiss]);

  const textareaStyle: React.CSSProperties = {
    width: 200,
    minHeight: 30,
    fontSize: editFontSize,
    fontFamily: editFontFamily,
    color: editColor,
    border: '1px solid #3498db',
    outline: 'none',
    padding: '4px 8px',
    background: 'white',
    resize: 'both',
    fontWeight: editBold ? 'bold' : 'normal',
    fontStyle: editItalic ? 'italic' : 'normal',
    textDecoration: editUnderline ? 'underline' : 'none',
  };

  const toolbarStyle: React.CSSProperties = {
    position: 'fixed',
    left: editPosition.x * viewport.zoom + viewport.x,
    top: editPosition.y * viewport.zoom + viewport.y - 36,
    zIndex: 1001,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    background: '#1e293b',
    borderRadius: 8,
    border: '1px solid #334155',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    flexWrap: 'wrap',
    maxWidth: Math.min(500, typeof window !== 'undefined' ? window.innerWidth - 20 : 500),
  };

  const btnBase: React.CSSProperties = {
    width: 26,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    background: 'transparent',
    color: '#e2e8f0',
    padding: 0,
  };

  const renderEditOverlay = editingId && (
    <>
      <div style={toolbarStyle}>
        <select
          value={editFontSize}
          onChange={(e) => setEditFontSize(Number(e.target.value))}
          style={{
            width: 52,
            height: 26,
            fontSize: 11,
            background: '#0f172a',
            color: '#e2e8f0',
            border: '1px solid #334155',
            borderRadius: 4,
            cursor: 'pointer',
            padding: '0 4px',
            outline: 'none',
          }}
          data-testid="text-editor-font-size"
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>{s}px</option>
          ))}
        </select>

        <select
          value={editFontFamily}
          onChange={(e) => setEditFontFamily(e.target.value)}
          style={{
            width: 90,
            height: 26,
            fontSize: 11,
            background: '#0f172a',
            color: '#e2e8f0',
            border: '1px solid #334155',
            borderRadius: 4,
            cursor: 'pointer',
            padding: '0 4px',
            outline: 'none',
          }}
          data-testid="text-editor-font-family"
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
          ))}
        </select>

        <button
          onClick={() => setEditBold(!editBold)}
          style={{ ...btnBase, background: editBold ? '#3b82f6' : 'transparent', fontWeight: 'bold' }}
          title="Bold"
          data-testid="text-editor-bold"
        >B</button>

        <button
          onClick={() => setEditItalic(!editItalic)}
          style={{ ...btnBase, background: editItalic ? '#3b82f6' : 'transparent', fontStyle: 'italic' }}
          title="Italic"
          data-testid="text-editor-italic"
        >I</button>

        <button
          onClick={() => setEditUnderline(!editUnderline)}
          style={{ ...btnBase, background: editUnderline ? '#3b82f6' : 'transparent', textDecoration: 'underline' }}
          title="Underline"
          data-testid="text-editor-underline"
        >U</button>

        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setEditColor(c)}
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: editColor === c ? '2px solid #3b82f6' : '1px solid #475569',
              background: c === '#ffffff' ? '#fff' : c,
              cursor: 'pointer',
              padding: 0,
            }}
            title={`Color ${c}`}
            data-testid={`text-editor-color-${c.replace('#', '')}`}
          />
        ))}

        <button
          onClick={handleEditSave}
          style={{ ...btnBase, background: '#22c55e', color: '#fff', marginLeft: 4 }}
          title="Apply"
          data-testid="text-editor-apply"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      </div>

      <div
        style={{
          position: 'fixed',
          left: editPosition.x * viewport.zoom + viewport.x,
          top: editPosition.y * viewport.zoom + viewport.y,
          zIndex: 1000,
        }}
      >
        <textarea
          ref={textareaRef}
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleTextareaKeyDown}
          style={textareaStyle}
          data-testid="text-editor-textarea"
        />
      </div>
    </>
  );

  if (tool !== 'text') return null;
  return <>{renderEditOverlay}</>;
}

import React from 'react';

interface UndoRedoBarProps {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function UndoRedoBar({ onUndo, onRedo, canUndo, canRedo }: UndoRedoBarProps) {

  const tooltipClasses = "absolute bottom-full left-1/2 -translate-x-1/2 bg-slate-900 text-slate-200 px-2 py-1 rounded text-xs whitespace-nowrap mb-1 pointer-events-none opacity-0 transition-opacity duration-150";

  return (
    <div className="flex gap-1">
      <div className="relative">
        <button
          data-testid="whiteboard-undo-btn"
          title="Undo"
          className={`flex items-center justify-center w-9 h-9 bg-slate-800 border-none rounded-lg cursor-pointer text-slate-200 text-[16px] transition-colors duration-150 ${canUndo ? 'hover:bg-slate-700' : 'opacity-40 cursor-not-allowed bg-slate-950'}`}
          onClick={onUndo}
          disabled={!canUndo}
          style={{ opacity: !canUndo ? 0.4 : 1, cursor: !canUndo ? 'not-allowed' : 'pointer' }}
          onMouseEnter={(e) => {
            const tooltip = (e.currentTarget as HTMLElement).querySelector('[data-tooltip]');
            if (tooltip) (tooltip as HTMLElement).style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            const tooltip = (e.currentTarget as HTMLElement).querySelector('[data-tooltip]');
            if (tooltip) (tooltip as HTMLElement).style.opacity = '0';
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 6L2 8L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 8H10C12.2091 8 14 9.79086 14 12V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div data-tooltip className={tooltipClasses}>Undo (Ctrl+Z)</div>
      </div>
      <div className="relative">
        <button
          data-testid="whiteboard-redo-btn"
          title="Redo"
          className={`flex items-center justify-center w-9 h-9 bg-slate-800 border-none rounded-lg cursor-pointer text-slate-200 text-[16px] transition-colors duration-150 ${canRedo ? 'hover:bg-slate-700' : 'opacity-40 cursor-not-allowed bg-slate-950'}`}
          onClick={onRedo}
          disabled={!canRedo}
          style={{ opacity: !canRedo ? 0.4 : 1, cursor: !canRedo ? 'not-allowed' : 'pointer' }}
          onMouseEnter={(e) => {
            const tooltip = (e.currentTarget as HTMLElement).querySelector('[data-tooltip]');
            if (tooltip) (tooltip as HTMLElement).style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            const tooltip = (e.currentTarget as HTMLElement).querySelector('[data-tooltip]');
            if (tooltip) (tooltip as HTMLElement).style.opacity = '0';
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M12 6L14 8L12 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 8H6C3.79086 8 2 9.79086 2 12V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div data-tooltip className={tooltipClasses}>Redo (Ctrl+Shift+Z)</div>
      </div>
    </div>
  );
}

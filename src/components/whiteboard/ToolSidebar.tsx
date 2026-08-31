import React from 'react';
import { TOOL_SHORTCUTS } from '@/lib/whiteboard/constants';
import type { ToolType } from '@/types/whiteboard';

interface ToolItem {
  id: ToolType;
  label: string;
  icon: React.ReactNode;
}

const TOOLS: ToolItem[] = [
  {
    id: 'select',
    label: 'Select',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 17l-8.5-5.5L22 6 2 2l4 20 5.5-8.5L22 17z" />
        <path d="M2 2l11.5 9.5" />
      </svg>
    ),
  },
  {
    id: 'pen',
    label: 'Pen',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    ),
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5" />
      </svg>
    ),
  },
  {
    id: 'circle',
    label: 'Circle',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="19" x2="19" y2="5" />
      </svg>
    ),
  },
  {
    id: 'arrow',
    label: 'Arrow',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    ),
  },
  {
    id: 'stickyNote',
    label: 'Sticky Note',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9z" />
        <path d="M16 3v6h6" />
      </svg>
    ),
  },
  {
    id: 'eraser',
    label: 'Eraser',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 20H7L3 16C2 15 2 13 3 12L13 2L22 11C23 12 23 14 22 15L20 17" />
        <path d="M17 17H7" />
      </svg>
    ),
  },
];

interface ToolSidebarProps {
  activeTool: string;
  onToolChange: (tool: string) => void;
  onOpenLibrary: () => void;
  onOpenHelp: () => void;
  showHostTools?: boolean;
  isGuiding?: boolean;
  onToggleGuide?: () => void;
}

export default function ToolSidebar({
  activeTool,
  onToolChange,
  onOpenLibrary,
  onOpenHelp,
  showHostTools = false,
  isGuiding = false,
  onToggleGuide,
}: ToolSidebarProps) {
  return (
    /*
     * Centred along the bottom, at every size.
     *
     * This was a column down the left edge on anything wider than a phone,
     * which cost the board a strip of drawing surface for its whole height and
     * left the tools somewhere no other control lives. The middle of the
     * bottom edge came free when undo, redo and Clear moved into Excalidraw's
     * footer, and a horizontal bar there is the shape the phone always had --
     * so the desktop stops being the odd one out.
     */
    <div
      data-testid="whiteboard-tool-bar"
      className="fixed inset-x-0 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-50 flex items-center justify-center px-2 pointer-events-none"
    >
      <div className="bg-slate-900/95 border border-slate-700/80 rounded-2xl p-1.5 shadow-2xl shadow-slate-950/30 backdrop-blur-md flex max-w-full flex-row gap-1 overflow-x-auto pointer-events-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TOOLS.map((t) => {
          const isActive = activeTool === t.id;
          const shortcut = TOOL_SHORTCUTS[t.id];
          return (
            <div
              key={t.id}
              data-testid={`whiteboard-tool-${t.id}`}
              onClick={() => onToolChange(t.id)}
              className={`h-11 w-11 shrink-0 sm:h-10 sm:w-10 flex items-center justify-center cursor-pointer rounded-xl relative transition-all duration-200 group ${
                isActive
                  ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30 scale-105'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
              }`}
              title={`${t.label} (${shortcut})`}
            >
              {t.icon}
              <span
                className="absolute left-full ml-3 hidden sm:flex px-2.5 py-1.5 bg-slate-950/95 border border-slate-800/80 text-slate-100 rounded-lg text-xs whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 scale-95 group-hover:scale-100 transition-all duration-150 shadow-2xl z-50 items-center gap-1.5 font-medium"
              >
                <span>{t.label}</span>
                <kbd className="px-1 py-0.5 bg-slate-800 border border-slate-700/80 text-slate-400 rounded text-[0.625rem] leading-none uppercase font-semibold">
                  {shortcut}
                </kbd>
              </span>
            </div>
          );
        })}
        {showHostTools && (
          <>
            <div className="mx-1 shrink-0 self-stretch border-l border-slate-700/80 sm:mx-0 sm:my-1 sm:self-auto sm:border-l-0 sm:border-t" />
            <button
              type="button"
              data-testid="whiteboard-tool-guide"
              aria-label={isGuiding ? 'Stop guiding' : 'Guide class'}
              onClick={onToggleGuide}
              className={`group relative flex h-11 w-11 shrink-0 sm:h-10 sm:w-10 cursor-pointer items-center justify-center rounded-xl transition-all duration-200 ${isGuiding ? 'bg-blue-500 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}
              title={isGuiding ? 'Stop guiding' : 'Guide class'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12h18" />
                <path d="M12 3v18" />
                <circle cx="12" cy="12" r="8" />
              </svg>
              <span className="absolute left-full z-50 ml-3 hidden sm:flex scale-95 items-center whitespace-nowrap rounded-lg border border-slate-800/80 bg-slate-950/95 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-2xl transition-all duration-150 pointer-events-none group-hover:scale-100 group-hover:opacity-100">
                {isGuiding ? 'Stop guiding' : 'Guide class'}
              </span>
            </button>
            <button
              type="button"
              data-testid="whiteboard-tool-library"
              onClick={onOpenLibrary}
              className="group relative flex h-11 w-11 shrink-0 sm:h-10 sm:w-10 cursor-pointer items-center justify-center rounded-xl text-slate-400 transition-all duration-200 hover:bg-slate-800 hover:text-slate-100"
              title="Library"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="absolute left-full z-50 ml-3 hidden sm:flex scale-95 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-800/80 bg-slate-950/95 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-2xl transition-all duration-150 pointer-events-none group-hover:scale-100 group-hover:opacity-100">
                Library
              </span>
            </button>
            <button
              type="button"
              data-testid="whiteboard-tool-help"
              onClick={onOpenHelp}
              className="group relative flex h-11 w-11 shrink-0 sm:h-10 sm:w-10 cursor-pointer items-center justify-center rounded-xl text-slate-400 transition-all duration-200 hover:bg-slate-800 hover:text-slate-100"
              title="Help"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.1 9a3 3 0 1 1 5.8 1c-.5 1.4-2.1 1.8-2.6 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="absolute left-full z-50 ml-3 hidden sm:flex scale-95 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-800/80 bg-slate-950/95 px-2.5 py-1.5 text-xs font-medium text-slate-100 opacity-0 shadow-2xl transition-all duration-150 pointer-events-none group-hover:scale-100 group-hover:opacity-100">
                Help
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

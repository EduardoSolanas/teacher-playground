import { useState, useRef, useEffect, useCallback } from 'react';

type ExportButtonProps = {
  stageRef: React.RefObject<any>;
  onExportPNG: (scale: 1 | 2 | 4) => void;
  onExportSVG: () => void;
  exporting: boolean;
};

export default function ExportButton({
  stageRef,
  onExportPNG,
  onExportSVG,
  exporting,
}: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleExport = (format: 'png' | 'svg') => {
    if (format === 'png') {
      onExportPNG(1);
    } else {
      onExportSVG();
    }
    setOpen(false);
  };

  const handleScale = (scale: 1 | 2 | 4) => {
    onExportPNG(scale);
    setOpen(false);
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        data-testid="whiteboard-export-btn"
        onClick={() => setOpen(!open)}
        disabled={exporting}
        title="Export board"
        className="flex items-center gap-1.5 px-3 py-2 border border-slate-700/80 rounded-lg bg-slate-900 text-slate-200 cursor-pointer text-[13px] font-medium shadow-lg shadow-slate-900/15 transition-colors duration-150 hover:bg-slate-800"
        style={{ cursor: exporting ? 'not-allowed' : 'pointer', opacity: exporting ? 0.6 : 1 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export
      </button>

      {open && (
        <div
          className="absolute top-full right-0 mt-1 bg-slate-800 rounded-lg shadow-xl border border-slate-700 min-w-[180px] z-[100] overflow-hidden"
        >
          <div>
            <button
              data-testid="whiteboard-export-png-1x"
              onClick={() => handleExport('png')}
              className="block w-full px-4 py-2.5 border-none bg-transparent text-slate-200 cursor-pointer text-[13px] text-left transition-colors duration-150 hover:bg-slate-700"
            >
              Export as PNG (1x)
            </button>
            <button
              data-testid="whiteboard-export-png-2x"
              onClick={() => handleScale(2)}
              className="block w-full px-4 py-2.5 border-none bg-transparent text-slate-200 cursor-pointer text-[13px] text-left transition-colors duration-150 hover:bg-slate-700"
            >
              Export as PNG (2x)
            </button>
            <button
              data-testid="whiteboard-export-png-4x"
              onClick={() => handleScale(4)}
              className="block w-full px-4 py-2.5 border-none bg-transparent text-slate-200 cursor-pointer text-[13px] text-left transition-colors duration-150 hover:bg-slate-700"
            >
              Export as PNG (4x)
            </button>
            <div className="h-px bg-slate-700 my-1" />
            <button
              data-testid="whiteboard-export-svg"
              onClick={() => handleExport('svg')}
              className="block w-full px-4 py-2.5 border-none bg-transparent text-slate-200 cursor-pointer text-[13px] text-left transition-colors duration-150 hover:bg-slate-700"
            >
              Export as SVG
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

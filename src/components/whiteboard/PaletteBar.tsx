import React from 'react';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';
import { COLOR_PRESETS, STROKE_WIDTHS } from '@/lib/whiteboard/constants';

export default function PaletteBar() {
  const { palette, setPalette } = useWhiteboardStore();

  return (
    <div
      className="fixed left-20 top-3 h-10 flex items-center z-50 pointer-events-none"
      data-testid="whiteboard-palette"
    >
      <div className="bg-slate-900/95 border border-slate-700/80 rounded-xl shadow-xl shadow-slate-900/20 backdrop-blur-md flex items-center h-10 px-3.5 gap-4 pointer-events-auto">
        <div className="flex gap-1.5 items-center">
          <span className="text-slate-400 text-[11px] font-semibold tracking-wide uppercase mr-1 select-none">Color</span>
          {COLOR_PRESETS.map((color) => (
            <div
              key={color}
              data-testid={`whiteboard-color-${color}`}
              onClick={() => setPalette({ color })}
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: color,
                cursor: 'pointer',
                border: palette.color === color ? '3px solid #ffffff' : '2px solid #475569',
                boxShadow: palette.color === color ? '0 0 0 2px #3b82f6' : 'none',
                transition: 'all 0.15s',
              }}
              className="hover:scale-110 active:scale-95"
            />
          ))}
        </div>

        <div className="w-px h-5 bg-slate-800/80" />

        <div className="flex gap-1 items-center">
          <span className="text-slate-400 text-[11px] font-semibold tracking-wide uppercase mr-1 select-none">Stroke</span>
          {STROKE_WIDTHS.map((w) => (
            <div
              key={w}
              data-testid={`whiteboard-stroke-${w}`}
              onClick={() => setPalette({ strokeWidth: w })}
              style={{
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                borderRadius: 6,
                border: palette.strokeWidth === w ? '2px solid #3b82f6' : '1px solid #475569',
                background: palette.strokeWidth === w ? '#1e293b' : 'transparent',
                transition: 'all 0.15s',
              }}
              className="hover:bg-slate-850 hover:text-slate-100 active:scale-95"
            >
              <div
                style={{
                  width: Math.min(w + 3, 14),
                  height: Math.min(w, 8),
                  background: palette.color,
                  borderRadius: 1,
                }}
              />
            </div>
          ))}
        </div>

        <div className="w-px h-5 bg-slate-800/80" />

        <div className="flex gap-1.5 items-center">
          <span className="text-slate-400 text-[11px] font-semibold tracking-wide uppercase mr-1 select-none">Fill</span>
          <div
            data-testid="whiteboard-fill-toggle"
            onClick={() =>
              setPalette({ fill: palette.fill === 'transparent' ? '#3b82f6' : 'transparent' })
            }
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              background:
                palette.fill === 'transparent'
                  ? 'repeating-conic-gradient(#334155 0% 25%, #1e293b 0% 50%) 50% / 6px 6px'
                  : palette.fill,
              cursor: 'pointer',
              border: palette.fill !== 'transparent' ? '2px solid #3b82f6' : '2px solid #475569',
              transition: 'all 0.15s',
            }}
            className="hover:scale-105 active:scale-95 shadow-inner"
            title={palette.fill === 'transparent' ? 'Transparent' : 'Solid Fill'}
          />
        </div>
      </div>
    </div>
  );
}

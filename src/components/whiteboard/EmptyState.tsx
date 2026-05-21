import { useState, useEffect } from 'react';

export default function EmptyState() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    try {
      const hasSeen = localStorage.getItem('whiteboard_hints_shown');
      if (hasSeen) {
        setShown(true);
      }
    } catch {
      // localStorage unavailable
    }
  }, []);

  const dismiss = () => {
    setShown(true);
    try {
      localStorage.setItem('whiteboard_hints_shown', 'true');
    } catch {
      // localStorage unavailable
    }
  };

  if (shown) return null;

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-5"
    >
      <h2
        className="m-0 mb-2 text-xl font-semibold text-slate-700"
      >
        Drag, draw, and collaborate in real-time
      </h2>
      <p className="m-0 mb-6 text-sm text-slate-400">
        Invite others to collaborate on this whiteboard
      </p>
      <div
        className="flex gap-4 pointer-events-auto"
      >
        {['Pen (P)', 'Rectangle (R)', 'Text (T)', 'Circle (C)'].map((hint) => (
          <span
            key={hint}
            className="bg-slate-100 px-3 py-1.5 rounded-md text-xs text-slate-500"
          >
            {hint}
          </span>
        ))}
      </div>
      <button
        onClick={dismiss}
        className="mt-4 bg-none border-none text-slate-400 text-xs cursor-pointer pointer-events-auto"
      >
        Dismiss
      </button>
    </div>
  );
}

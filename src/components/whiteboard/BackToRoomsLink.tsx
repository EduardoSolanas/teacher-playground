'use client';

export default function BackToRoomsLink({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  return (
    <a
      href="/whiteboard"
      data-testid="whiteboard-back-to-rooms"
      onClick={(event) => {
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate();
      }}
      className="fixed left-3 top-3 z-[1100] rounded-lg border border-slate-700/80 bg-slate-900/95 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 shadow-lg shadow-slate-950/30 backdrop-blur-md transition-colors hover:bg-slate-800 hover:text-white"
    >
      Back to rooms
    </a>
  );
}

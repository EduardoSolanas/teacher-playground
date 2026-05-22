interface LibraryPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function LibraryPanel({ visible, onClose }: LibraryPanelProps) {
  if (!visible) return null;

  return (
    <div
      data-testid="whiteboard-library-panel"
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[90%] max-w-[420px] rounded-xl border border-slate-700 bg-slate-800 p-5 text-slate-200 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-lg font-semibold">Library</h2>
          <button
            data-testid="whiteboard-library-close"
            type="button"
            onClick={onClose}
            className="cursor-pointer border-none bg-transparent px-2 text-[20px] text-slate-400 hover:text-slate-100"
          >
            &times;
          </button>
        </div>
        <div className="rounded-lg border border-dashed border-slate-600 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
          Saved whiteboard items will appear here.
        </div>
      </div>
    </div>
  );
}

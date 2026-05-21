import { useState, useCallback } from 'react';

type ClearBoardModalProps = {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ClearBoardModal({
  isOpen,
  onConfirm,
  onCancel,
}: ClearBoardModalProps) {
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onCancel();
      }
    },
    [onCancel]
  );

  if (!isOpen) return null;

  return (
    <div
      onClick={handleBackdropClick}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
    >
      <div
        className="bg-slate-800 rounded-xl p-6 max-w-[400px] w-[90%] border border-slate-700 shadow-2xl"
      >
        <h3
          className="m-0 mb-3 text-lg font-semibold text-slate-100"
        >
          Clear Board
        </h3>
        <p
          className="m-0 mb-6 text-sm text-slate-400 leading-relaxed"
        >
          This will remove all elements for all users. Are you sure?
        </p>
        <div className="flex gap-3 justify-end">
          <button
            data-testid="whiteboard-clear-cancel-btn"
            onClick={onCancel}
            className="px-5 py-2 border border-slate-600 rounded-lg bg-transparent text-slate-300 cursor-pointer text-sm"
          >
            Cancel
          </button>
          <button
            data-testid="whiteboard-clear-confirm-btn"
            onClick={onConfirm}
            className="px-5 py-2 border-none rounded-lg bg-red-600 text-white cursor-pointer text-sm font-medium"
          >
            Clear Board
          </button>
        </div>
      </div>
    </div>
  );
}

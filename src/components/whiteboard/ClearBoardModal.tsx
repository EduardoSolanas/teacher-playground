import { useCallback, useEffect, useRef } from 'react';

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
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Save focus before opening and restore after closing
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
      cancelBtnRef.current?.focus();
    } else {
      previousActiveElementRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Tab') {
        // Focus containment: wrap focus between the two buttons.
        // Focus that already escaped (a click on the dialog text leaves it on
        // the body) is pulled back in rather than allowed to walk the board
        // behind the modal.
        if (!dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          cancelBtnRef.current?.focus();
        } else if (e.shiftKey) {
          // Shift+Tab from Cancel button wraps to Clear Board button
          if (document.activeElement === cancelBtnRef.current) {
            e.preventDefault();
            confirmBtnRef.current?.focus();
          }
        } else {
          // Tab from Clear Board button wraps to Cancel button
          if (document.activeElement === confirmBtnRef.current) {
            e.preventDefault();
            cancelBtnRef.current?.focus();
          }
        }
      }
    };

    /*
     * On the document, not on the dialog element. Clicking a non-focusable part
     * of the dialog (the explanatory text) drops focus to the body, and a
     * listener bound to the dialog would never see the keydown -- Escape would
     * silently stop working on a destructive confirmation.
     */
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onCancel]);

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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-board-title"
        className="bg-slate-800 rounded-xl p-6 max-w-[25rem] w-[90%] border border-slate-700 shadow-2xl"
      >
        <h3
          id="clear-board-title"
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
            ref={cancelBtnRef}
            data-testid="whiteboard-clear-cancel-btn"
            onClick={onCancel}
            className="px-5 py-2 border border-slate-600 rounded-lg bg-transparent text-slate-300 cursor-pointer text-sm"
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
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

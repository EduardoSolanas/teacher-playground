import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The focus half of the ConfirmDialog pattern, for dialogs that live in a
 * different shell. ConfirmDialog itself owns the Escape/backdrop behaviour; the
 * join gates are deliberately non-dismissable and only need focus contained.
 *
 * Focus moves to the initial target (or the first focusable) when the caller
 * mounts, and Tab/Shift+Tab wrap at the dialog's edges so nothing behind it
 * becomes reachable. The element focused before mounting gets focus back on
 * unmount.
 */
export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    previousActiveElementRef.current = previous instanceof HTMLElement ? previous : null;
    const target =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      null;
    target?.focus();
    return () => {
      previousActiveElementRef.current?.focus();
    };
  }, [dialogRef, initialFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dialogRef]);
}

type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  body: string;
  /** Wording on the destructive button, e.g. "Clear board". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Prefix for the dialog's test ids, so two dialogs never collide. */
  testIdPrefix: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A confirmation for something destructive and shared.
 *
 * Extracted from ClearBoardModal when ending a call for a whole room needed the
 * same treatment. The accessible behaviour is the point of it, and it is easy
 * to get subtly wrong twice: a named dialog, focus starting on the safe action,
 * Escape to cancel, focus contained, and focus restored to whatever opened it.
 *
 * Not the native <dialog> element: jsdom does not implement showModal, so the
 * behaviour would not be unit-testable in this repo.
 *
 * Rendered into document.body rather than where it is written. The call rail
 * carries backdrop-blur, and a backdrop-filter makes its element a containing
 * block for `position: fixed` descendants -- a dialog inside it is trapped in a
 * 15rem column instead of covering the viewport.
 */
export default function ConfirmDialog({
  isOpen,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  testIdPrefix,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const titleId = `${testIdPrefix}-title`;

  // Portalling needs a document, which server rendering has not got.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Focus starts on the safe action, not the destructive one, and returns to
  // whatever opened the dialog when it closes.
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
      cancelBtnRef.current?.focus();
    } else {
      previousActiveElementRef.current?.focus();
    }
  }, [isOpen, mounted]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Tab') {
        // Focus that already escaped -- clicking the explanatory text leaves it
        // on the body -- is pulled back in rather than allowed to walk the page
        // behind the dialog.
        if (!dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          cancelBtnRef.current?.focus();
        } else if (e.shiftKey) {
          if (document.activeElement === cancelBtnRef.current) {
            e.preventDefault();
            confirmBtnRef.current?.focus();
          }
        } else if (document.activeElement === confirmBtnRef.current) {
          e.preventDefault();
          cancelBtnRef.current?.focus();
        }
      }
    };

    /*
     * On the document, not on the dialog element. Clicking a non-focusable part
     * of the dialog drops focus to the body, and a listener bound to the dialog
     * would never see the keydown -- Escape would silently stop working on a
     * destructive confirmation.
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
    [onCancel],
  );

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      onClick={handleBackdropClick}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1600]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl p-8 max-w-[25rem] w-[90%] shadow-xl"
      >
        <h3 id={titleId} className="m-0 mb-3 text-lg font-semibold text-slate-900">
          {title}
        </h3>
        <p className="m-0 mb-6 text-sm text-slate-500 leading-relaxed">{body}</p>
        <div className="flex gap-3 justify-end">
          <button
            ref={cancelBtnRef}
            data-testid={`${testIdPrefix}-cancel-btn`}
            onClick={onCancel}
            className="px-5 py-2 border border-slate-300 rounded-lg bg-transparent text-slate-600 cursor-pointer text-sm"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            data-testid={`${testIdPrefix}-confirm-btn`}
            onClick={onConfirm}
            className="px-5 py-2 border-none rounded-lg bg-red-600 text-white cursor-pointer text-sm font-medium"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

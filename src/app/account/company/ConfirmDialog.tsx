'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useDialogFocusTrap } from '@/components/ConfirmDialog';

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  testIdPrefix,
  busy = false,
  confirmDisabled = false,
  error = null,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  testIdPrefix: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = `${testIdPrefix}-title`;

  useDialogFocusTrap(dialogRef, cancelRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      className="fixed inset-0 z-[1600] flex items-center justify-center bg-black/60"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[90%] max-w-[25rem] rounded-xl bg-white p-8 shadow-xl"
      >
        <h3 id={titleId} className="m-0 mb-3 text-lg font-semibold text-slate-900">
          {title}
        </h3>
        <p className="m-0 mb-3 text-sm leading-relaxed text-slate-500">{body}</p>
        {children}
        {error !== null && (
          <p
            role="alert"
            data-testid={`${testIdPrefix}-error`}
            className="m-0 mb-4 text-sm font-medium text-red-600"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            data-testid={`${testIdPrefix}-cancel`}
            disabled={busy}
            onClick={onCancel}
            className="cursor-pointer rounded-lg border border-slate-300 bg-transparent px-5 py-2 text-sm text-slate-600 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid={`${testIdPrefix}-confirm`}
            disabled={busy || confirmDisabled}
            aria-disabled={busy || confirmDisabled ? 'true' : undefined}
            onClick={onConfirm}
            className="cursor-pointer rounded-lg border-none bg-red-600 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

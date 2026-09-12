'use client';

import { useEffect, useId, useRef } from 'react';
import { useDialogFocusTrap } from '@/components/ConfirmDialog';

export default function InertConfirmDialog({
  title,
  body,
  confirmLabel,
  note,
  testIdPrefix,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  note: string;
  testIdPrefix: string;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = `${testIdPrefix}-title`;
  const noteId = `${testIdPrefix}-note`;

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
        <p id={noteId} data-testid={`${testIdPrefix}-note`} className="m-0 mb-6 text-sm font-medium text-amber-700">
          {note}
        </p>
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            data-testid={`${testIdPrefix}-cancel`}
            onClick={onCancel}
            className="cursor-pointer rounded-lg border border-slate-300 bg-transparent px-5 py-2 text-sm text-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-describedby={noteId}
            data-testid={`${testIdPrefix}-confirm`}
            className="cursor-not-allowed rounded-lg border-none bg-red-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

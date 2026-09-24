import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDialogFocusTrap } from '@/components/ConfirmDialog';
import { defaultPageRange, parsePageRange } from '@/lib/documents/pdfImport';

type PdfImportDialogProps = {
  /** The already-opened document, so this dialog never touches PDF.js itself. */
  pdf: PDFDocumentProxy;
  /** The file's name, shown so the teacher knows which PDF this is about. */
  fileName: string;
  /** Chosen 1-based pages, ascending. Rendering happens after this returns. */
  onChoose: (pages: number[]) => void;
  onCancel: () => void;
};

/**
 * The one choice the board cannot make on its own (spec/PDF_IMPORT_SPEC.md
 * §3): which pages of a PDF longer than `MAX_PAGES_PER_IMPORT` to add.
 * Every other stage this dialog used to have -- opening the file, rendering
 * pages, showing a failure -- moved to the drop/paste status line in
 * RoomClient, which runs whether or not this dialog ever opens.
 *
 * Rendered into document.body for the same reason ConfirmDialog is: an
 * ancestor with a backdrop filter would otherwise trap `position: fixed`.
 */
export default function PdfImportDialog({ pdf, fileName, onChoose, onCancel }: PdfImportDialogProps) {
  const [range, setRange] = useState(() => defaultPageRange(pdf.numPages));
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = 'pdf-import-title';

  useEffect(() => setMounted(true), []);
  useDialogFocusTrap(dialogRef);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  if (!mounted) return null;

  const secondaryButton =
    'px-5 py-2 border border-slate-300 rounded-lg bg-transparent text-slate-600 cursor-pointer text-sm';
  const primaryButton =
    'px-5 py-2 border-none rounded-lg bg-slate-900 text-white cursor-pointer text-sm font-medium';

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1600]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="pdf-import-dialog"
        className="bg-white rounded-xl p-6 sm:p-8 max-w-[28rem] w-[90%] shadow-xl"
      >
        <h3 id={titleId} className="m-0 mb-1 text-lg font-semibold text-slate-900">
          Insert PDF
        </h3>
        <p className="m-0 mb-5 text-sm text-slate-500 break-words" data-testid="pdf-import-file">
          {fileName}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parsePageRange(range, pdf.numPages);
            if (!parsed.ok) {
              setRangeError(parsed.message);
              return;
            }
            onChoose(parsed.pages);
          }}
        >
          <label htmlFor="pdf-import-range" className="block mb-1 text-sm font-medium text-slate-700">
            Pages to insert (this PDF has {pdf.numPages})
          </label>
          <input
            id="pdf-import-range"
            data-testid="pdf-import-range"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={range}
            aria-invalid={rangeError !== null}
            aria-describedby={rangeError ? 'pdf-import-range-error' : undefined}
            onChange={(event) => {
              setRange(event.target.value);
              setRangeError(null);
            }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          />
          {rangeError && (
            <p id="pdf-import-range-error" data-testid="pdf-import-range-error" role="alert" className="m-0 mt-2 text-sm text-red-700">
              {rangeError}
            </p>
          )}
          <div className="flex gap-3 justify-end mt-6">
            <button type="button" onClick={onCancel} className={secondaryButton} data-testid="pdf-import-cancel">
              Cancel
            </button>
            <button type="submit" className={primaryButton} data-testid="pdf-import-insert">
              Insert
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

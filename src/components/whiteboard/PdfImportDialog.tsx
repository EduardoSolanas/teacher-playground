import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useDialogFocusTrap } from '@/components/ConfirmDialog';
import { defaultPageRange, failureMessage, parsePageRange } from '@/lib/documents/pdfImport';
import {
  dataUrlBytes,
  formatMegabytes,
  freeBytes,
  importTooLargeMessage,
  type RoomStorage,
} from '@/lib/documents/roomStorage';
import { openPdf, renderPage, type RenderedPage } from './pdfRenderer';

type Stage =
  | { kind: 'opening' }
  | { kind: 'choose'; pdf: PDFDocumentProxy; range: string; rangeError: string | null }
  | { kind: 'rendering'; done: number; total: number }
  | { kind: 'error'; message: string };

type PdfImportDialogProps = {
  /** The file the teacher picked. The dialog opens it; it never leaves the browser. */
  file: File;
  /**
   * What the room's pictures already weigh, against the cap. Null when the
   * figures could not be read, in which case the upload route stays the only
   * check, as it was before.
   */
  storage: RoomStorage | null;
  /** Receives every rendered page at once, so the board gets one undoable insert. */
  onInsert: (pages: readonly RenderedPage[]) => void;
  onClose: () => void;
};

/**
 * Insert PDF (spec/PDF_IMPORT_SPEC.md §3): choose pages, render them here, hand
 * the whole set to the board. Any failure or a cancel inserts nothing.
 *
 * Rendered into document.body for the same reason ConfirmDialog is: an
 * ancestor with a backdrop filter would otherwise trap `position: fixed`.
 */
export default function PdfImportDialog({ file, storage, onInsert, onClose }: PdfImportDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'opening' });
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const destroyRef = useRef<(() => Promise<void>) | null>(null);
  const cancelledRef = useRef(false);
  const titleId = 'pdf-import-title';

  useEffect(() => setMounted(true), []);
  useDialogFocusTrap(dialogRef);

  useEffect(() => {
    let active = true;
    void openPdf(file).then((result) => {
      if (!active) {
        if (result.ok) void result.destroy();
        return;
      }
      if (!result.ok) {
        setStage({ kind: 'error', message: failureMessage(result.failure) });
        return;
      }
      destroyRef.current = result.destroy;
      setStage({
        kind: 'choose',
        pdf: result.pdf,
        range: defaultPageRange(result.pdf.numPages),
        rangeError: null,
      });
    });
    return () => {
      active = false;
      cancelledRef.current = true;
      // The parsed document holds the whole file and its worker state.
      void destroyRef.current?.();
      destroyRef.current = null;
    };
  }, [file]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelledRef.current = true;
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const cancel = () => {
    cancelledRef.current = true;
    onClose();
  };

  const insert = async (pdf: PDFDocumentProxy, range: string) => {
    const parsed = parsePageRange(range, pdf.numPages);
    if (!parsed.ok) {
      setStage({ kind: 'choose', pdf, range, rangeError: parsed.message });
      return;
    }
    const rendered: RenderedPage[] = [];
    for (const [index, pageNumber] of parsed.pages.entries()) {
      if (cancelledRef.current) return;
      setStage({ kind: 'rendering', done: index, total: parsed.pages.length });
      try {
        rendered.push(await renderPage(pdf, pageNumber));
      } catch {
        if (cancelledRef.current) return;
        setStage({ kind: 'error', message: failureMessage({ kind: 'page', page: pageNumber }) });
        return;
      }
    }
    if (cancelledRef.current) return;

    /*
     * The room's cap is checked here, with the rendered bytes in hand, rather
     * than guessed before rendering: a page's size is not knowable until it is
     * drawn. Refusing now costs the teacher the render but leaves the board as
     * it was -- the alternative was pages landing on the board and their
     * uploads failing one by one.
     */
    if (storage) {
      const needed = rendered.reduce((total, page) => total + dataUrlBytes(page.dataURL), 0);
      const tooLarge = importTooLargeMessage(needed, storage.used, storage.limit);
      if (tooLarge) {
        setStage({ kind: 'error', message: tooLarge });
        return;
      }
    }

    onInsert(rendered);
    onClose();
  };

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
          {file.name}
        </p>

        {stage.kind === 'opening' && (
          <p className="m-0 mb-6 text-sm text-slate-600" role="status">Opening…</p>
        )}

        {stage.kind === 'choose' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void insert(stage.pdf, stage.range);
            }}
          >
            <label htmlFor="pdf-import-range" className="block mb-1 text-sm font-medium text-slate-700">
              Pages to insert (this PDF has {stage.pdf.numPages})
            </label>
            <input
              id="pdf-import-range"
              data-testid="pdf-import-range"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={stage.range}
              aria-invalid={stage.rangeError !== null}
              aria-describedby={stage.rangeError ? 'pdf-import-range-error' : undefined}
              onChange={(event) => setStage({ ...stage, range: event.target.value, rangeError: null })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            />
            {stage.rangeError && (
              <p id="pdf-import-range-error" data-testid="pdf-import-range-error" role="alert" className="m-0 mt-2 text-sm text-red-700">
                {stage.rangeError}
              </p>
            )}
            {storage && (
              <p className="m-0 mt-2 text-xs text-slate-500" data-testid="pdf-import-storage">
                {formatMegabytes(freeBytes(storage.used, storage.limit))} free in this room
              </p>
            )}
            <div className="flex gap-3 justify-end mt-6">
              <button type="button" onClick={cancel} className={secondaryButton} data-testid="pdf-import-cancel">
                Cancel
              </button>
              <button type="submit" className={primaryButton} data-testid="pdf-import-insert">
                Insert
              </button>
            </div>
          </form>
        )}

        {stage.kind === 'rendering' && (
          <>
            <p className="m-0 mb-6 text-sm text-slate-600" role="status" data-testid="pdf-import-progress">
              Rendering page {stage.done + 1} of {stage.total}…
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={cancel} className={secondaryButton} data-testid="pdf-import-cancel">
                Cancel
              </button>
            </div>
          </>
        )}

        {stage.kind === 'error' && (
          <>
            <p className="m-0 mb-6 text-sm text-red-700" role="alert" data-testid="pdf-import-error">
              {stage.message}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={cancel} className={secondaryButton} data-testid="pdf-import-close">
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

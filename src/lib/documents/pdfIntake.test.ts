import { describe, expect, it } from 'vitest';
import {
  addingPageMessage,
  documentOrigins,
  dragOverHasPdf,
  isPdfFile,
  MIXED_DROP_MESSAGE,
  needsPageRangeChoice,
  NOT_OWNER_MESSAGE,
  pdfsInDrop,
  someNonPdf,
} from './pdfIntake';

describe('isPdfFile', () => {
  it('is a PDF by its declared type', () => {
    expect(isPdfFile({ type: 'application/pdf', name: 'anything.bin' })).toBe(true);
  });

  it('is a PDF by a .pdf name when the type is not application/pdf', () => {
    expect(isPdfFile({ type: '', name: 'worksheet.PDF' })).toBe(true);
    expect(isPdfFile({ type: '', name: 'worksheet.pdf' })).toBe(true);
  });

  it('is not a PDF when neither the type nor the name says so', () => {
    expect(isPdfFile({ type: 'image/png', name: 'photo.png' })).toBe(false);
    expect(isPdfFile({ type: '', name: 'lesson.docx' })).toBe(false);
  });

  it('requires the name to end in .pdf, not merely contain it', () => {
    expect(isPdfFile({ type: '', name: 'worksheet.pdf.bak' })).toBe(false);
  });
});

describe('pdfsInDrop', () => {
  it('keeps only the PDFs, in order', () => {
    const files = [
      { type: 'image/png', name: 'photo.png' },
      { type: 'application/pdf', name: 'a.pdf' },
      { type: '', name: 'b.pdf' },
    ];
    expect(pdfsInDrop(files)).toEqual([files[1], files[2]]);
  });

  it('is empty when the drop holds no PDF', () => {
    expect(pdfsInDrop([{ type: 'image/png', name: 'photo.png' }])).toEqual([]);
  });
});

describe('someNonPdf', () => {
  it('is true when a drop with a PDF also carries something else', () => {
    const files = [
      { type: 'application/pdf', name: 'a.pdf' },
      { type: 'image/png', name: 'photo.png' },
    ];
    expect(someNonPdf(files)).toBe(true);
  });

  it('is false when every file is a PDF', () => {
    expect(someNonPdf([{ type: 'application/pdf', name: 'a.pdf' }])).toBe(false);
  });

  it('is false for an all-picture drop (nothing to compare against)', () => {
    expect(someNonPdf([{ type: 'image/png', name: 'photo.png' }])).toBe(false);
  });
});

describe('needsPageRangeChoice', () => {
  it('does not ask at or under the import cap', () => {
    expect(needsPageRangeChoice(1)).toBe(false);
    expect(needsPageRangeChoice(50)).toBe(false);
  });

  it('asks past the import cap', () => {
    expect(needsPageRangeChoice(51)).toBe(true);
  });
});

describe('documentOrigins', () => {
  it('centres the first document on the drop point', () => {
    const [origin] = documentOrigins([{ width: 100, height: 200 }], { x: 500, y: 500 });
    expect(origin).toEqual({ x: 450, y: 400 });
  });

  it('places each further document beside the last, with a gap', () => {
    const origins = documentOrigins(
      [
        { width: 100, height: 200 },
        { width: 60, height: 80 },
      ],
      { x: 0, y: 0 },
    );
    expect(origins).toEqual([
      { x: -50, y: -100 },
      { x: 110, y: -40 }, // next x is 0 + 100 (first width) + 40 (gap) = 140, minus half the second width (30)
    ]);
  });

  it('is empty for no documents', () => {
    expect(documentOrigins([], { x: 0, y: 0 })).toEqual([]);
  });
});

describe('dragOverHasPdf', () => {
  it('is true when a dragged item is typed as a PDF', () => {
    expect(dragOverHasPdf([{ type: 'text/plain' }, { type: 'application/pdf' }])).toBe(true);
  });

  it('is false when no item is typed as a PDF', () => {
    expect(dragOverHasPdf([{ type: 'image/png' }])).toBe(false);
  });

  it('is false when the browser reports no types at all (Safari): no hint, drop still works', () => {
    expect(dragOverHasPdf([])).toBe(false);
    expect(dragOverHasPdf(null)).toBe(false);
    expect(dragOverHasPdf(undefined)).toBe(false);
  });
});

describe('status-line messages', () => {
  it('names the page being added', () => {
    expect(addingPageMessage(1, 3)).toBe('Adding page 1 of 3…');
    expect(addingPageMessage(3, 3)).toBe('Adding page 3 of 3…');
  });

  it('has fixed wording for the owner-only and mixed-drop cases', () => {
    expect(NOT_OWNER_MESSAGE).toBe('Only the teacher can add a PDF.');
    expect(MIXED_DROP_MESSAGE).toBe('Only the PDF was added. Drop pictures on their own.');
  });
});

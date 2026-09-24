import type { Page } from '@playwright/test';

/**
 * A PDF comes in by drop or paste, not a picker (spec/PDF_IMPORT_SPEC.md §3),
 * so the e2e suite has to build a real `DataTransfer` carrying a real `File`
 * in the page and dispatch the drag/drop or clipboard events themselves --
 * there is no input element to set files on any more.
 */

function toBase64(bytes: Buffer): string {
  return bytes.toString('base64');
}

/** Drops a PDF at the centre of the board's canvas area. */
export async function dropPdfOnBoard(page: Page, name: string, bytes: Buffer): Promise<void> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('the board canvas area is not on screen');
  await dropPdfAt(page, name, bytes, box.x + box.width / 2, box.y + box.height / 2);
}

/** Drops a PDF at a specific point in the viewport, to prove placement follows it. */
export async function dropPdfAt(page: Page, name: string, bytes: Buffer, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ name, base64, x, y }) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
      const file = new File([array], name, { type: 'application/pdf' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`nothing at (${x}, ${y}) to drop on`);
      const eventInit: DragEventInit = { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y };
      target.dispatchEvent(new DragEvent('dragenter', eventInit));
      target.dispatchEvent(new DragEvent('dragover', eventInit));
      target.dispatchEvent(new DragEvent('drop', eventInit));
    },
    { name, base64: toBase64(bytes), x, y },
  );
}

/** Drops several PDFs at once, as one multi-file drop, at the board's centre. */
export async function dropPdfsOnBoard(page: Page, files: { name: string; bytes: Buffer }[]): Promise<void> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('the board canvas area is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ({ files, x, y }) => {
      const dataTransfer = new DataTransfer();
      for (const { name, base64 } of files) {
        const binary = atob(base64);
        const array = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
        dataTransfer.items.add(new File([array], name, { type: 'application/pdf' }));
      }
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`nothing at (${x}, ${y}) to drop on`);
      const eventInit: DragEventInit = { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y };
      target.dispatchEvent(new DragEvent('dragenter', eventInit));
      target.dispatchEvent(new DragEvent('dragover', eventInit));
      target.dispatchEvent(new DragEvent('drop', eventInit));
    },
    { files: files.map(({ name, bytes }) => ({ name, base64: toBase64(bytes) })), x, y },
  );
}

/** Drops a picture (not a PDF) at the board's centre, the way Excalidraw already handles it. */
export async function dropPictureOnBoard(page: Page, name: string, bytes: Buffer, mimeType: string): Promise<void> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('the board canvas area is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ({ name, base64, mimeType, x, y }) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
      const file = new File([array], name, { type: mimeType });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`nothing at (${x}, ${y}) to drop on`);
      const eventInit: DragEventInit = { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y };
      target.dispatchEvent(new DragEvent('dragenter', eventInit));
      target.dispatchEvent(new DragEvent('dragover', eventInit));
      target.dispatchEvent(new DragEvent('drop', eventInit));
    },
    { name, base64: toBase64(bytes), mimeType, x, y },
  );
}

/** Drops a PDF alongside a picture in one drop, at the board's centre. */
export async function dropMixedOnBoard(
  page: Page,
  pdf: { name: string; bytes: Buffer },
  picture: { name: string; bytes: Buffer; mimeType: string },
): Promise<void> {
  const box = await page.getByTestId('whiteboard-canvas-area').boundingBox();
  if (!box) throw new Error('the board canvas area is not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ({ pdf, picture, x, y }) => {
      const toFile = (name: string, base64: string, mimeType: string) => {
        const binary = atob(base64);
        const array = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
        return new File([array], name, { type: mimeType });
      };
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(toFile(pdf.name, pdf.base64, 'application/pdf'));
      dataTransfer.items.add(toFile(picture.name, picture.base64, picture.mimeType));
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`nothing at (${x}, ${y}) to drop on`);
      const eventInit: DragEventInit = { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y };
      target.dispatchEvent(new DragEvent('dragenter', eventInit));
      target.dispatchEvent(new DragEvent('dragover', eventInit));
      target.dispatchEvent(new DragEvent('drop', eventInit));
    },
    {
      pdf: { name: pdf.name, base64: toBase64(pdf.bytes) },
      picture: { name: picture.name, base64: toBase64(picture.bytes), mimeType: picture.mimeType },
      x,
      y,
    },
  );
}

/** Pastes a PDF onto the board, which lands at the centre of the view (no drop point). */
export async function pastePdfOnBoard(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.evaluate(
    ({ name, base64 }) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
      const file = new File([array], name, { type: 'application/pdf' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const target = document.querySelector('[data-testid="whiteboard-canvas-area"]');
      if (!target) throw new Error('no board canvas area to paste onto');
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer }),
      );
    },
    { name, base64: toBase64(bytes) },
  );
}

/**
 * Hands a file to the browser to save.
 *
 * Lifted out of the room list when the board gained a Save as of its own, so
 * the two do not drift: the object URL has to be revoked after the click or
 * the blob is held for as long as the tab lives, and that is exactly the sort
 * of detail one copy remembers and the other forgets.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

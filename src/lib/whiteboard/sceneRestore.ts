import { excalidrawElementsEqual } from './excalidrawSyncCore';

/**
 * Whether the board the shared document holds still has to be put in the editor.
 *
 * Asked once, when the editor announces itself: by then the document may have
 * synced already, may sync in a moment, or may have been applied to a scene
 * Excalidraw then overwrote while it finished initialising. The only answer
 * that survives all three is the editor's own scene -- what arrived on the wire
 * is not evidence that anything is on the canvas.
 */
export function shouldRestoreScene(
  shared: readonly unknown[],
  held: readonly unknown[],
): boolean {
  if (shared.length === 0) return false;
  return !excalidrawElementsEqual(shared, held);
}

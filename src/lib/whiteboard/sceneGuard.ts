import * as Y from 'yjs';
import {
  BLOCKED_ELEMENT_TYPES,
  MAX_ELEMENTS,
  isAllowedElementLink,
} from './requestSchemas';

export type SanitizeSceneResult = {
  changed: boolean;
  removedBlocked: number;
  removedLinks: number;
  removedMalformed: number;
  removedOverflow: number;
};

/*
 * Element types scrubbed from the live document.
 *
 * `BLOCKED_ELEMENT_TYPES` is the HTTP scene route's list, and `image` is on it
 * because that route carries elements only. The live document is different:
 * a pasted photograph is an `image` element whose bytes live in the room's R2
 * store under `fileId`, and the client sends it over the socket. Scrubbing
 * `image` here deletes every photograph a class pastes (the e2e board-images
 * feature), so the socket guard keeps it and removes the three embed types the
 * audit names as injection surfaces.
 */
const SCRUBBED_ELEMENT_TYPES = new Set(
  [...BLOCKED_ELEMENT_TYPES].filter((type) => type !== 'image'),
);

/**
 * Strips from a live Yjs document whatever the HTTP scene route refuses.
 *
 * The scene route validated `roomSceneSchema`, but the primary write path is
 * the authenticated Yjs WebSocket, which until now applied whatever arrived and
 * relayed it on (SEC-A02). This is the server-side twin of that schema, run on
 * every applied sync update: an admitted editor can no longer persist or
 * propagate a blocked element type, an unsafe link, or an over-cap scene.
 *
 * Every deletion happens in one `server-sanitize` transaction, so peers receive
 * a single CRDT delete set and the document's dirty listener sees one change.
 */
export function sanitizeSceneDoc(
  doc: Y.Doc,
  options: { maxElements?: number } = {},
): SanitizeSceneResult {
  const maxElements = options.maxElements ?? MAX_ELEMENTS;
  const elements = doc.getArray<Y.Map<unknown>>('elements');
  const current = elements.toArray();
  const remove = new Set<number>();
  let removedBlocked = 0;
  let removedLinks = 0;
  let removedMalformed = 0;
  let removedOverflow = 0;

  current.forEach((element, index) => {
    /*
     * A Y.Array takes any value, so a hostile update can push a plain string
     * or number here. Every peer conversion calls `yMap.forEach`, so one of
     * these throws for each of them and wedges the projection flush. It is not
     * an element and never relaying or storing it is the only safe answer.
     */
    if (!(element instanceof Y.Map)) {
      remove.add(index);
      removedMalformed += 1;
      return;
    }

    const type = element.get('type');
    if (typeof type === 'string' && SCRUBBED_ELEMENT_TYPES.has(type.trim().toLowerCase())) {
      remove.add(index);
      removedBlocked += 1;
      return;
    }

    const link = element.get('link');
    if (link != null && (typeof link !== 'string' || !isAllowedElementLink(link))) {
      remove.add(index);
      removedLinks += 1;
    }
  });

  const keepCount = current.length - remove.size;
  if (keepCount > maxElements) {
    removedOverflow = keepCount - maxElements;
    let kept = 0;
    current.forEach((_element, index) => {
      if (remove.has(index)) return;
      kept += 1;
      if (kept > maxElements) remove.add(index);
    });
  }

  if (remove.size === 0) {
    return { changed: false, removedBlocked, removedLinks, removedMalformed, removedOverflow };
  }

  doc.transact(() => {
    const indexes = [...remove].sort((a, b) => b - a);
    for (const index of indexes) elements.delete(index, 1);
  }, 'server-sanitize');

  return { changed: true, removedBlocked, removedLinks, removedMalformed, removedOverflow };
}

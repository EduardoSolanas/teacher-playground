import * as Y from 'yjs';
import { valuesEqual } from './yjsValue';

/**
 * spec/PAGED_DOCUMENTS_SPEC.md §7 / §7.1: only the room owner may create,
 * change or remove a document page element. This module is the pure decision
 * (plain objects, no Yjs) plus a Yjs adapter that records what one frame
 * touched and undoes the refused part of it.
 */

export type ElementRecord = Record<string, unknown>;

/**
 * "Carries `customData.pdfPage`" per §7: the key is present and not null,
 * whatever its shape. A malformed stamp is protected like a valid one, and
 * `undefined` (the key absent) is not "present".
 */
export function carriesPdfPage(customData: unknown): boolean {
  if (customData === null || typeof customData !== 'object') return false;
  if (!('pdfPage' in (customData as Record<string, unknown>))) return false;
  return (customData as { pdfPage?: unknown }).pdfPage !== null;
}

/** What one frame did to one element that existed before the frame. */
export type ChangedElement = {
  /** Every key the frame touched, mapped to its value before the frame. */
  changedKeys: Map<string, unknown>;
  /** `customData` before the frame (unchanged if the frame did not touch it). */
  beforeCustomData: unknown;
  /** `customData` after the frame (unchanged if the frame did not touch it). */
  afterCustomData: unknown;
};

/** Everything one frame touched on the elements array. */
export type FrameRecord = {
  /** Elements that existed before the frame and still exist, keyed by id. */
  changed: Map<string, ChangedElement>;
  /** Elements the frame inserted, keyed by id. */
  created: Map<string, ElementRecord>;
  /** Elements the frame removed from the array, keyed by id. */
  removed: Map<string, ElementRecord>;
};

/** What must be undone to enforce §7 against a non-owner frame. */
export type FrameDecision = {
  /**
   * Per element id, the keys to restore. A value of `undefined` means the key
   * did not exist before the frame and must be deleted, not set.
   */
  restore: Map<string, Map<string, unknown>>;
  /** Ids of newly created page elements to remove entirely. */
  removeCreatedIds: string[];
  /** Ids of removed page elements to re-insert, with their old content. */
  reinsert: Map<string, ElementRecord>;
};

/**
 * The three §7 rules, decided on plain data. Whether an element existed
 * before the frame, and whether it still does, is the caller's job (that is
 * what distinguishes "changed", "created" and "removed" in {@link FrameRecord}).
 */
export function decideFrame(frame: FrameRecord): FrameDecision {
  const restore = new Map<string, Map<string, unknown>>();
  for (const [id, change] of frame.changed) {
    const keys = decideChangedElement(change);
    if (keys.length === 0) continue;
    const oldValues = new Map<string, unknown>();
    for (const key of keys) oldValues.set(key, change.changedKeys.get(key));
    restore.set(id, oldValues);
  }

  const removeCreatedIds: string[] = [];
  for (const [id, element] of frame.created) {
    if (carriesPdfPage(element.customData)) removeCreatedIds.push(id);
  }

  const reinsert = new Map<string, ElementRecord>();
  for (const [id, element] of frame.removed) {
    if (carriesPdfPage(element.customData)) reinsert.set(id, element);
  }

  return { restore, removeCreatedIds, reinsert };
}

/**
 * Which of a changed element's touched keys must be restored.
 *
 * - The element already carried `pdfPage` before the frame: every key the
 *   frame touched is refused (geometry, `locked`, `isDeleted`, `customData`,
 *   `fileId`, anything -- §7's second bullet).
 * - The element did not carry `pdfPage` before, but does after: only
 *   `customData` is refused (§7's third bullet -- adding the stamp).
 * - Otherwise nothing is refused.
 */
function decideChangedElement(change: ChangedElement): string[] {
  if (carriesPdfPage(change.beforeCustomData)) {
    return [...change.changedKeys.keys()];
  }
  if (change.changedKeys.has('customData') && carriesPdfPage(change.afterCustomData)) {
    return ['customData'];
  }
  return [];
}

/**
 * The HTTP scene route's twin of {@link recordPageGuardFrame}: it has no
 * incremental frame to observe, only the previously stored elements and the
 * submitted array, so it diffs the two lists by id instead.
 */
export function frameFromElementLists(
  before: ReadonlyArray<ElementRecord>,
  after: ReadonlyArray<ElementRecord>,
): FrameRecord {
  const beforeById = new Map<string, ElementRecord>();
  for (const element of before) {
    if (typeof element.id === 'string' && element.id.length > 0) beforeById.set(element.id, element);
  }
  const afterById = new Map<string, ElementRecord>();
  for (const element of after) {
    if (typeof element.id === 'string' && element.id.length > 0) afterById.set(element.id, element);
  }

  const changed = new Map<string, ChangedElement>();
  const created = new Map<string, ElementRecord>();
  for (const [id, afterElement] of afterById) {
    const beforeElement = beforeById.get(id);
    if (!beforeElement) {
      created.set(id, afterElement);
      continue;
    }
    const keys = new Set([...Object.keys(beforeElement), ...Object.keys(afterElement)]);
    const changedKeys = new Map<string, unknown>();
    for (const key of keys) {
      if (!valuesEqual(beforeElement[key], afterElement[key])) {
        changedKeys.set(key, beforeElement[key]);
      }
    }
    if (changedKeys.size > 0) {
      changed.set(id, {
        changedKeys,
        beforeCustomData: beforeElement.customData,
        afterCustomData: afterElement.customData,
      });
    }
  }

  const removed = new Map<string, ElementRecord>();
  for (const [id, beforeElement] of beforeById) {
    if (!afterById.has(id)) removed.set(id, beforeElement);
  }

  return { changed, created, removed };
}

/**
 * Applies a {@link FrameDecision} to a plain element list (the HTTP scene
 * route's submitted array), producing the corrected array to store: refused
 * created elements dropped, refused keys restored, refused removals
 * re-inserted.
 */
export function applyFrameDecisionToList(
  after: ReadonlyArray<ElementRecord>,
  decision: FrameDecision,
): ElementRecord[] {
  const removeIds = new Set(decision.removeCreatedIds);
  const corrected: ElementRecord[] = [];
  for (const element of after) {
    const id = typeof element.id === 'string' ? element.id : undefined;
    if (id && removeIds.has(id)) continue;
    const patch = id ? decision.restore.get(id) : undefined;
    if (!patch) {
      corrected.push(element);
      continue;
    }
    const next: ElementRecord = { ...element };
    for (const [key, oldValue] of patch) {
      if (oldValue === undefined) delete next[key];
      else next[key] = oldValue;
    }
    corrected.push(next);
  }
  for (const element of decision.reinsert.values()) corrected.push(element);
  return corrected;
}

// --- Yjs adapter -----------------------------------------------------------

function elementId(map: Y.Map<unknown>): string | undefined {
  const id = map.get('id');
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function livePlainElement(map: Y.Map<unknown>): ElementRecord {
  const out: ElementRecord = {};
  map.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Reads a Y.Map's content after it (and its parent array entry) has been
 * deleted in the same transaction.
 *
 * `Y.Map.get` returns `undefined` for every key the instant the map is
 * deleted -- deleting a map recursively marks every one of its content items
 * deleted too, and the public getter refuses deleted items regardless of
 * transaction boundaries. The content itself is not gone yet: each key's
 * `Item` still holds its last-written value until Yjs garbage-collects the
 * delete set, which happens only once this transaction finishes cleaning up
 * -- after `observeDeep` listeners run. Walking the map's internal key ->
 * `Item` table and reading each item's content directly (bypassing the
 * `.deleted` guard `get` applies) is therefore the only way to recover a
 * removed page element's content for the undo, and it is safe only inside
 * the observer that fires for this same transaction.
 */
function deletedPlainElement(map: Y.Map<unknown>): ElementRecord {
  const out: ElementRecord = {};
  const internal = (map as unknown as { _map: Map<string, { content: { getContent(): unknown[] } }> })._map;
  internal.forEach((item, key) => {
    const content = item.content.getContent();
    out[key] = content[content.length - 1];
  });
  return out;
}

/**
 * Attaches an `observeDeep` listener to `elementsArray` for the duration of
 * `apply`, and returns what that one call changed.
 *
 * Nothing is snapshotted up front -- the listener only ever sees what this
 * one frame touched, so cost scales with the frame, not with how many pages
 * the room holds. The listener is attached only around `apply`, so any
 * sanitize transaction that runs outside it is never recorded.
 */
export function recordPageGuardFrame(
  elementsArray: Y.Array<Y.Map<unknown>>,
  apply: () => void,
): FrameRecord {
  const changed = new Map<string, ChangedElement>();
  const created = new Map<string, ElementRecord>();
  const removed = new Map<string, ElementRecord>();

  const observer = (events: Array<Y.YEvent<any>>) => {
    for (const event of events) {
      if (event.target === elementsArray) {
        for (const item of event.changes.added) {
          for (const content of item.content.getContent()) {
            if (!(content instanceof Y.Map)) continue;
            const id = elementId(content as Y.Map<unknown>);
            if (!id) continue;
            created.set(id, livePlainElement(content as Y.Map<unknown>));
          }
        }
        for (const item of event.changes.deleted) {
          for (const content of item.content.getContent()) {
            if (!(content instanceof Y.Map)) continue;
            const snapshot = deletedPlainElement(content as Y.Map<unknown>);
            const id = snapshot.id;
            if (typeof id !== 'string' || id.length === 0) continue;
            // An element created and removed within the same frame is not a
            // pre-existing page losing its content; it never reached a peer.
            if (created.delete(id)) continue;
            removed.set(id, snapshot);
          }
        }
        continue;
      }

      // A key change on one of the array's direct element maps: path is
      // exactly [index] from the array's own point of view.
      if (event.path.length !== 1 || !(event.target instanceof Y.Map)) continue;
      const map = event.target as Y.Map<unknown>;
      const id = elementId(map);
      if (!id) continue;

      let entry = changed.get(id);
      if (!entry) {
        /*
         * `afterCustomData` only matters once `customData` itself is a
         * touched key -- and the loop below always overwrites it the moment
         * that happens -- so there is nothing meaningful to read here yet.
         */
        entry = { changedKeys: new Map(), beforeCustomData: map.get('customData'), afterCustomData: undefined };
        changed.set(id, entry);
      }
      for (const [key, delta] of event.changes.keys) {
        if (!entry.changedKeys.has(key)) entry.changedKeys.set(key, delta.oldValue);
        if (key === 'customData') {
          entry.beforeCustomData = delta.oldValue;
          entry.afterCustomData = map.get('customData');
        }
      }
    }
  };

  elementsArray.observeDeep(observer);
  try {
    apply();
  } finally {
    elementsArray.unobserveDeep(observer);
  }

  return { changed, created, removed };
}

/**
 * Undoes the refused part of a frame in one `page-guard` transaction:
 * changed keys are set back to their old value (or deleted, when the frame
 * added them), created page elements are removed, and removed page elements
 * are re-inserted with their old content.
 */
export function applyPageGuardDecision(
  doc: Y.Doc,
  elementsArray: Y.Array<Y.Map<unknown>>,
  decision: FrameDecision,
): void {
  if (decision.restore.size === 0 && decision.removeCreatedIds.length === 0 && decision.reinsert.size === 0) {
    return;
  }

  doc.transact(() => {
    const byId = new Map<string, { map: Y.Map<unknown>; index: number }>();
    elementsArray.toArray().forEach((map, index) => {
      const id = elementId(map);
      if (id) byId.set(id, { map, index });
    });

    for (const [id, oldValues] of decision.restore) {
      const found = byId.get(id);
      if (!found) continue;
      for (const [key, oldValue] of oldValues) {
        if (oldValue === undefined) {
          found.map.delete(key);
        } else {
          found.map.set(key, oldValue);
        }
      }
    }

    const removeIndexes: number[] = [];
    for (const id of decision.removeCreatedIds) {
      const found = byId.get(id);
      if (found) removeIndexes.push(found.index);
    }
    removeIndexes.sort((a, b) => b - a);
    for (const index of removeIndexes) elementsArray.delete(index, 1);

    if (decision.reinsert.size > 0) {
      const restored: Y.Map<unknown>[] = [];
      for (const element of decision.reinsert.values()) {
        const map = new Y.Map<unknown>();
        for (const [key, value] of Object.entries(element)) map.set(key, value);
        restored.push(map);
      }
      elementsArray.push(restored);
    }
  }, 'page-guard');
}

/**
 * Records what `apply` changed on `elementsArray`, decides what to undo, and
 * undoes it -- the composition RoomDO and the HTTP scene route each need
 * around one write.
 */
export function enforcePageGuard(
  doc: Y.Doc,
  elementsArray: Y.Array<Y.Map<unknown>>,
  apply: () => void,
): FrameDecision {
  const frame = recordPageGuardFrame(elementsArray, apply);
  const decision = decideFrame(frame);
  applyPageGuardDecision(doc, elementsArray, decision);
  return decision;
}

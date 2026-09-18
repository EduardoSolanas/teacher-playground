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

/*
 * Owner-only document metadata (EMBEDDED_DOCUMENTS_SPEC §3, §4.3).
 *
 * A `document` element is one placed instance of an uploaded document. Its
 * references and display geometry are OWNER-ONLY state: the owner places,
 * moves, and re-pages it through the trusted server path, and the room's
 * authoritative document is the record of that state. Any client sync frame
 * that creates a document element, or changes a protected field on one, is an
 * editor mutation (or a forged one) and is sanitized against the
 * authoritative prior state before it can relay or persist. Shape validation
 * alone is not the check -- the protected fields are compared with what the
 * authoritative document already held.
 *
 * Editor annotation strokes near a document are ordinary elements and are
 * untouched, as are the document element's non-protected display fields
 * (`version`, `label`). The field allowlist itself stays closed: unknown
 * fields on a document element are stripped wherever one is sanitized.
 */
const PROTECTED_DOCUMENT_FIELDS = [
  'boardId',
  'instanceId',
  'documentId',
  'sharedPageIndex',
  'x',
  'y',
  'width',
  'height',
  'angle',
] as const;

const DOCUMENT_ELEMENT_KEYS = new Set([
  'id',
  'type',
  ...PROTECTED_DOCUMENT_FIELDS,
  'version',
  'label',
]);

/** Prior authoritative state of every document element, keyed by element id. */
export type DocumentElementsSnapshot = Map<string, Record<string, unknown>>;

function isDocumentElementType(element: Y.Map<unknown>): boolean {
  const type = element.get('type');
  return typeof type === 'string' && type.trim().toLowerCase() === 'document';
}

/** The element's id if it can key authoritative state, else null. */
function usableElementId(element: Y.Map<unknown>): string | null {
  const id = element.get('id');
  if (typeof id !== 'string' || id.length === 0) return null;
  return id;
}

/**
 * Snapshots the authoritative state of every document element.
 *
 * Called on the room's authoritative document before a client sync frame is
 * applied; the result is the prior state
 * {@link sanitizeDocumentElements} compares against.
 */
export function collectDocumentElements(doc: Y.Doc): DocumentElementsSnapshot {
  const snapshot: DocumentElementsSnapshot = new Map();
  for (const element of doc.getArray<Y.Map<unknown>>('elements').toArray()) {
    if (!(element instanceof Y.Map) || !isDocumentElementType(element)) continue;
    const id = usableElementId(element);
    if (id === null) continue;
    const record: Record<string, unknown> = {};
    for (const [key, value] of element.entries()) record[key] = plainClone(value);
    snapshot.set(id, record);
  }
  return snapshot;
}

export type SanitizeDocumentsResult = {
  changed: boolean;
  /** Document elements the authoritative prior state does not hold, removed. */
  removedUnauthorized: number;
  /** Owner-only fields restored to the authoritative prior value. */
  revertedFields: number;
  /** Fields outside the bounded contract, stripped. */
  strippedFields: number;
};

/**
 * Sanitizes document elements against the authoritative prior state.
 *
 * Runs on the room's authoritative document after a client sync frame is
 * applied. A document element the prior state does not hold was created by
 * the frame and is removed -- only the owner's trusted server path creates
 * one. Protected fields that the frame changed are restored to the prior
 * authoritative value, a type overwritten away from `document` is restored,
 * and fields outside the bounded contract are stripped. Everything happens in
 * one `server-sanitize` transaction, so the relayed diff carries the restored
 * state and never the editor mutation.
 */
export function sanitizeDocumentElements(
  doc: Y.Doc,
  prior: DocumentElementsSnapshot,
): SanitizeDocumentsResult {
  const elements = doc.getArray<Y.Map<unknown>>('elements');
  const remove = new Set<number>();
  const fieldMutations: Array<() => void> = [];
  let removedUnauthorized = 0;
  let revertedFields = 0;
  let strippedFields = 0;

  elements.toArray().forEach((element, index) => {
    if (!(element instanceof Y.Map)) return;
    // A non-string id cannot key authoritative state, so the lookup misses and
    // a document element carrying one is handled as an unauthorized creation.
    const priorRecord = prior.get(element.get('id') as string);

    if (isDocumentElementType(element)) {
      if (!priorRecord) {
        remove.add(index);
        removedUnauthorized += 1;
        return;
      }
    } else if (priorRecord) {
      // The authoritative state holds this id as a document element, so a
      // client frame that changed its type still mutated owner-only state.
      fieldMutations.push(() => element.set('type', priorRecord.type));
      revertedFields += 1;
    } else {
      return;
    }

    for (const key of [...element.keys()]) {
      if (!DOCUMENT_ELEMENT_KEYS.has(key)) {
        fieldMutations.push(() => element.delete(key));
        strippedFields += 1;
      }
    }

    for (const field of PROTECTED_DOCUMENT_FIELDS) {
      const priorValue = priorRecord[field];
      const currentValue = element.get(field);
      if (Object.is(currentValue, priorValue)) continue;
      fieldMutations.push(() => {
        if (priorValue === undefined) element.delete(field);
        else element.set(field, priorValue);
      });
      revertedFields += 1;
    }
  });

  if (remove.size === 0 && fieldMutations.length === 0) {
    return { changed: false, removedUnauthorized: 0, revertedFields: 0, strippedFields: 0 };
  }

  doc.transact(() => {
    for (const apply of fieldMutations) apply();
    const indexes = [...remove].sort((a, b) => b - a);
    for (const index of indexes) elements.delete(index, 1);
  }, 'server-sanitize');

  return { changed: true, removedUnauthorized, revertedFields, strippedFields };
}

/*
 * What each non-scene shared map may hold once a client update has landed.
 *
 * Every one of these maps is writable by any admitted editor -- `canWriteBoard`
 * is the only gate on a sync frame -- and until now nothing on the server
 * bounded them: an editor could flood `fileReady` with thousands of oversized
 * entries, invent types the app never defines, or forge call state, and the
 * server applied it, relayed it to every granted peer, and persisted it in the
 * snapshot. The `call` map is the strictest deliberately: call state moved to
 * the owner-gated binary control message (SEC-A04/R04), so no client map write
 * is sanctioned at all.
 */
type SharedMapRule = {
  maxEntries: number;
  keyPattern: RegExp;
  allowedValue: (value: unknown) => boolean;
};

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSmallPlainValue(value: unknown, maxChars = 2048): boolean {
  if (value instanceof Y.AbstractType) return false;
  if (value === null) return true;
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json !== undefined && json.length <= maxChars;
    } catch {
      return false;
    }
  }
  return true;
}

const SHARED_MAP_RULES: Record<string, SharedMapRule> = {
  // Image-readiness stamps: key is a file id, value a timestamp. The entry
  // cap sits well above any real board (the element cap bounds images too).
  fileReady: {
    maxEntries: 2000,
    keyPattern: /^[A-Za-z0-9_-]{1,128}$/,
    allowedValue: (value) => isFiniteNumber(value) && (value as number) >= 0,
  },
  // Cursor rows are keyed by peer id and carry one small position object.
  cursors: {
    maxEntries: 512,
    keyPattern: /^[\s\S]{1,128}$/,
    allowedValue: isSmallPlainValue,
  },
  // The host's saved view: exactly the three numbers the reader consumes.
  viewport: {
    maxEntries: 3,
    keyPattern: /^(x|y|zoom)$/,
    allowedValue: isFiniteNumber,
  },
  // Never client-writable. The binary control message owns call state.
  call: {
    maxEntries: 0,
    keyPattern: /^[\s\S]{1,128}$/,
    allowedValue: () => false,
  },
  // The room's board tabs: key is a board id, value one small definition.
  // Capped well above any lesson; the entry cap is what bounds a hostile
  // editor inventing boards.
  boardsMeta: {
    maxEntries: 50,
    keyPattern: /^[A-Za-z0-9_-]{1,64}$/,
    allowedValue: (value) => isSmallPlainValue(value, 256),
  },
};

/**
 * Bounds every shared type outside the elements array.
 *
 * Runs after {@link sanitizeSceneDoc} on the same applied sync update. A root
 * type that only arrived remotely is registered as a bare `AbstractType` â€”
 * this build's base class carries none of the map or list interface â€” so the
 * dispatcher reads where the content actually lives (`_map` for keyed
 * entries, `_length` for list items) and normalizes through the matching
 * accessor before pruning. Entries that break their map's rule are deleted,
 * unknown top-level types are emptied whatever they are, and everything
 * happens in one `scene-guard` transaction, so the relayed diff carries the
 * prunes and never the flood. Deleted content is garbage-collected by Yjs, so
 * the persisted snapshot does not retain it.
 */
export type SanitizeSharedResult = {
  /** Whether anything was pruned or an unknown root was seen. */
  changed: boolean;
  /** How many root names the app does not define carried content. */
  unknownRoots: number;
  /** How many entries were deleted from the app's own maps. */
  prunedEntries: number;
};

/**
 * Bounds every shared type outside the elements array.
 *
 * Runs on a document that just received a client update. A root type that only
 * arrived remotely is registered as a bare `AbstractType` â€” this build's base
 * class carries none of the map or list interface â€” so the dispatcher reads
 * where the content actually lives (`_map` for keyed entries, `_length` for
 * list items) and normalizes through the matching accessor before pruning.
 * Entries that break their map's rule are deleted and unknown top-level types
 * are emptied whatever they are.
 *
 * This alone does not make a flooded document small again: Yjs keeps a
 * tombstone record for every deleted key, so prune-on-apply still grows the
 * persisted snapshot by roughly one record per junk entry, frame after frame.
 * That is why the sync path runs this on a throwaway staging document and
 * applies only the structurally rebuilt survivor state (see
 * {@link buildCleanDoc}) â€” the flood never enters the real document's item
 * store at all. Run directly, the prune is the containment backstop for every
 * other path that applies updates.
 */
export function sanitizeSharedDoc(doc: Y.Doc): SanitizeSharedResult {
  let unknownRoots = 0;
  let prunedEntries = 0;
  doc.transact(() => {
    for (const [name, rawType] of [...doc.share.entries()]) {
      if (name === 'elements') continue;

      if (rawType instanceof Y.Map) {
        prunedEntries += pruneSharedMap(doc, name, SHARED_MAP_RULES[name]);
        if (SHARED_MAP_RULES[name] === undefined) unknownRoots += 1;
        continue;
      }
      if (rawType instanceof Y.Array) {
        emptySharedList(doc, name);
        unknownRoots += 1;
        continue;
      }
      // A bare AbstractType: a root this server never touched locally. Route
      // by where its content lives, then normalize through the public
      // accessor, which re-registers the root as the concrete class.
      const content = rawType as unknown as { _map?: Map<string, unknown>; _length?: number };
      if ((content._map?.size ?? 0) > 0) {
        prunedEntries += pruneSharedMap(doc, name, SHARED_MAP_RULES[name]);
        if (SHARED_MAP_RULES[name] === undefined) unknownRoots += 1;
      } else if ((content._length ?? 0) > 0) {
        emptySharedList(doc, name);
        unknownRoots += 1;
      }
    }
  }, 'scene-guard');
  return { changed: unknownRoots > 0 || prunedEntries > 0, unknownRoots, prunedEntries };
}

/** Returns how many entries were removed. */
function pruneSharedMap(doc: Y.Doc, name: string, rule?: SharedMapRule): number {
  const map = doc.getMap(name) as unknown as Y.Map<unknown>;
  if (!rule) {
    const keys = [...map.keys()];
    for (const key of keys) map.delete(key);
    return keys.length;
  }
  let kept = 0;
  let removed = 0;
  for (const [key, value] of [...map.entries()]) {
    if (kept < rule.maxEntries && rule.keyPattern.test(key) && rule.allowedValue(value)) {
      kept += 1;
    } else {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function emptySharedList(doc: Y.Doc, name: string): void {
  const list = doc.getArray(name);
  if (list.length > 0) list.delete(0, list.length);
}

/**
 * Rebuilds a staging document's surviving state as a fresh, tombstone-free
 * document.
 *
 * Only plain data crosses: every element property and map entry is copied by
 * value, so a hostile nested Y type inside an element drops that element
 * rather than smuggle live types into the room's authoritative document. The
 * `call` map is never copied: the binary control message owns call state.
 */
export function buildCleanDoc(staged: Y.Doc): Y.Doc {
  const clean = new Y.Doc();

  const elements = staged.getArray<Y.Map<unknown>>('elements');
  const cleanElements = clean.getArray<Y.Map<unknown>>('elements');
  const surviving: Y.Map<unknown>[] = [];
  for (const element of elements.toArray()) {
    const copy = new Y.Map<unknown>();
    let hostile = false;
    for (const [key, value] of element.entries()) {
      if (value instanceof Y.AbstractType) {
        hostile = true;
        break;
      }
      copy.set(key, plainClone(value));
    }
    if (!hostile) surviving.push(copy);
  }
  if (surviving.length > 0) cleanElements.push(surviving);

  for (const name of ['fileReady', 'viewport', 'cursors', 'boardsMeta'] as const) {
    const source = staged.getMap(name);
    const target = clean.getMap(name);
    for (const [key, value] of source.entries()) {
      target.set(key, plainClone(value));
    }
  }
  return clean;
}

function plainClone(value: unknown): unknown {
  if (value !== null && typeof value === 'object') return JSON.parse(JSON.stringify(value));
  return value;
}

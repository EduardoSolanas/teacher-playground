/**
 * Deciding what a scene change actually has to send.
 *
 * Excalidraw fires onChange for every pointer sample, so this runs tens of
 * times a second while someone draws. Publishing the whole scene each time made
 * the cost of one stroke grow with the size of the board — the drawing lag that
 * was reproducible with the host alone, before any peer joined.
 *
 * The work lives here rather than inside the canvas component because it is
 * where the bugs have been, and inside a component it could only be reached
 * through React. Here it can be driven directly against a real Y.Doc.
 */

/** Element ids mapped to the version last handed to the shared document. */
export type VersionBaseline = ReadonlyMap<string, number>;

export type SceneDiff = {
  /** Versions to remember once this change has been published. */
  nextVersions: Map<string, number>;
  /** Ids whose version moved since the baseline. */
  changedIds: Set<string>;
  /** Whether anything present in the baseline has since disappeared. */
  removed: boolean;
};

function elementId(element: unknown): string | null {
  const id = (element as { id?: unknown })?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function elementVersion(element: unknown): number {
  const version = (element as { version?: unknown })?.version;
  return typeof version === 'number' ? version : 0;
}

/** Compare a scene against the last published baseline. */
export function diffScene(previous: VersionBaseline, elements: readonly unknown[]): SceneDiff {
  const nextVersions = new Map<string, number>();
  for (const element of elements) {
    const id = elementId(element);
    if (id === null) continue;
    nextVersions.set(id, elementVersion(element));
  }

  let removed = false;
  for (const id of previous.keys()) {
    if (!nextVersions.has(id)) {
      removed = true;
      break;
    }
  }

  const changedIds = new Set<string>();
  for (const [id, version] of nextVersions) {
    if (previous.get(id) !== version) changedIds.add(id);
  }

  return { nextVersions, changedIds, removed };
}

/**
 * Whether a diff is worth serializing at all.
 *
 * `force` is for the end of a stroke. The version check treats Excalidraw's
 * `version` as capturing everything about an element, and a finished stroke is
 * the one moment that must not be trusted: if the last points land without a
 * version bump, the peer keeps whichever partial stroke the previous throttled
 * commit sent, permanently. One redundant publish per stroke is cheaper than
 * truncating one.
 */
export function shouldPublish(diff: SceneDiff, force = false): boolean {
  return force || diff.removed || diff.changedIds.size > 0;
}

/**
 * The elements to hand to the shared document.
 *
 * A removal needs the whole scene, because the stale sweep has to know what
 * survived. Everything else sends only what moved — while drawing that is a
 * single element, so the Yjs walk stops scaling with the size of the board.
 *
 * `force` is for the end of a stroke: when force=true and changedIds is empty,
 * republish elements that existed in the baseline (they need to reach the peer
 * even without a version bump). Only includes elements from the baseline, never
 * new elements.
 */
export function elementsToPublish<T>(
  elements: readonly T[],
  diff: SceneDiff,
  force = false,
): { elements: readonly T[]; wholeScene: boolean } {
  if (diff.removed) return { elements, wholeScene: true };

  if (force && diff.changedIds.size === 0) {
    return {
      elements: elements.filter((element) => {
        const id = elementId(element);
        return id !== null && diff.nextVersions.has(id);
      }),
      wholeScene: false,
    };
  }

  return {
    elements: elements.filter((element) => {
      const id = elementId(element);
      return id !== null && diff.changedIds.has(id);
    }),
    wholeScene: false,
  };
}

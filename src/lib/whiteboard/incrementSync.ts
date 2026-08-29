import { redactForLog } from '@/lib/http/safeError';

type IncrementMap = ReadonlyMap<string, unknown>;

export type StoreIncrementEventLike = {
  source?: string;
  elementsChange: {
    added: IncrementMap;
    removed: IncrementMap;
    updated: IncrementMap;
  };
};

export function isRemoteIncrement(event: StoreIncrementEventLike): boolean {
  return event.source === 'remote';
}

export type PublishCandidate = {
  elements: readonly unknown[];
  wholeScene: boolean;
};

function elementId(element: unknown): string | null {
  const id = (element as { id?: unknown })?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function changedElementIds(event: StoreIncrementEventLike): Set<string> {
  const ids = new Set<string>();
  for (const changes of [
    event.elementsChange.added,
    event.elementsChange.removed,
    event.elementsChange.updated,
  ]) {
    for (const id of changes.keys()) {
      if (id.length > 0) ids.add(id);
    }
  }
  return ids;
}

export function incrementSceneChange(
  event: StoreIncrementEventLike,
  elements: readonly unknown[],
): PublishCandidate {
  const changedIds = changedElementIds(event);
  const wholeScene = event.elementsChange.removed.size > 0;
  return {
    elements: wholeScene
      ? elements
      : elements.filter((element) => {
          const id = elementId(element);
          return id !== null && changedIds.has(id);
        }),
    wholeScene,
  };
}

function elementVersion(element: unknown): number | null {
  const version = (element as { version?: unknown })?.version;
  return typeof version === 'number' ? version : null;
}

export function updateVersionBaselineFromIncrement(
  baseline: ReadonlyMap<string, number>,
  event: StoreIncrementEventLike,
  elements: readonly unknown[],
): Map<string, number> {
  const nextBaseline = new Map(baseline);
  const sceneVersions = new Map<string, number>();

  for (const element of elements) {
    const id = elementId(element);
    const version = elementVersion(element);
    if (id === null || version === null) continue;
    sceneVersions.set(id, version);
  }

  for (const id of event.elementsChange.removed.keys()) {
    nextBaseline.delete(id);
  }

  for (const changes of [event.elementsChange.added, event.elementsChange.updated]) {
    for (const id of changes.keys()) {
      const version = sceneVersions.get(id);
      if (version !== undefined) nextBaseline.set(id, version);
    }
  }

  /*
   * Nothing may survive here that the scene no longer has.
   *
   * diffScene reports a removal by finding a baseline id missing from the
   * scene, so one stale entry latches `wholeScene: true` permanently and every
   * later publish sends the whole board rather than the element that moved.
   * Rebuilding the baseline from the scene made that impossible for free;
   * maintaining it incrementally does not, so it is enforced.
   */
  for (const id of nextBaseline.keys()) {
    if (!sceneVersions.has(id)) nextBaseline.delete(id);
  }

  return nextBaseline;
}

export function publishCandidatesEqual(
  left: PublishCandidate,
  right: PublishCandidate,
): boolean {
  return left.wholeScene === right.wholeScene
    && JSON.stringify(left.elements) === JSON.stringify(right.elements);
}

function candidateSummary(candidate: PublishCandidate) {
  return {
    wholeScene: candidate.wholeScene,
    count: candidate.elements.length,
    ids: candidate.elements
      .map(elementId)
      .filter((id): id is string => id !== null),
  };
}

export function formatIncrementComparisonWarning(
  legacy: PublishCandidate,
  increment: PublishCandidate,
): string {
  return redactForLog(JSON.stringify({
    event: 'whiteboard_increment_mismatch',
    op: 'compare_publish_candidates',
    legacyCount: legacy.elements.length,
    incrementCount: increment.elements.length,
    legacy: candidateSummary(legacy),
    increment: candidateSummary(increment),
  }));
}

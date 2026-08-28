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

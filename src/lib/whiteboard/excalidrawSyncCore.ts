const EXCALIDRAW_TOOL_BY_APP_TOOL: Record<string, string> = {
  select: 'selection', pen: 'freedraw', text: 'text', rectangle: 'rectangle',
  circle: 'ellipse', line: 'line', arrow: 'arrow', stickyNote: 'rectangle', eraser: 'eraser',
};

const VALID_EXCALIDRAW_ELEMENT_TYPES = new Set([
  'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image',
  'frame', 'magicframe', 'iframe', 'embeddable',
]);

export function toExcalidrawToolType(tool: string): string {
  return EXCALIDRAW_TOOL_BY_APP_TOOL[tool] ?? 'selection';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeExcalidrawElement(element: unknown): Record<string, unknown> | null {
  if (!isRecord(element) || typeof element.type !== 'string') return null;
  if (!VALID_EXCALIDRAW_ELEMENT_TYPES.has(element.type)) return null;
  return JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
}

export function uniqueElementsById<T extends { id?: unknown }>(elements: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const element of elements) {
    if (typeof element.id !== 'string' || element.id.length === 0) continue;
    merged.set(element.id, element);
  }
  return Array.from(merged.values());
}

export function serializeExcalidrawElements(elements: readonly unknown[]): Record<string, unknown>[] {
  return elements.map(serializeExcalidrawElement)
    .filter((element): element is Record<string, unknown> => element != null);
}

export function excalidrawElementsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(serializeExcalidrawElements(a)) === JSON.stringify(serializeExcalidrawElements(b));
}

function elementVersion(element: Record<string, unknown>): number {
  const version = element.version;
  return typeof version === 'number' && Number.isFinite(version) ? version : 0;
}

function elementId(element: unknown): string | null {
  if (!isRecord(element)) return null;
  return typeof element.id === 'string' && element.id.length > 0 ? element.id : null;
}

export function mergeApiSnapshotElements(
  local: readonly unknown[],
  remote: readonly unknown[],
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const element of serializeExcalidrawElements(local)) {
    const id = elementId(element);
    if (id) merged.set(id, element);
  }
  for (const element of serializeExcalidrawElements(remote)) {
    const id = elementId(element);
    if (!id) continue;
    const current = merged.get(id);
    if (!current || elementVersion(element) > elementVersion(current)) merged.set(id, element);
  }
  return [...merged.values()];
}

export interface RemoteReconciliationOptions {
  isPointerDown: boolean;
  seenRemoteIds: ReadonlySet<string>;
  lastPublishedIds: readonly string[];
}

export function selectElementsForRemoteReconciliation(
  localElements: readonly unknown[],
  remoteElements: readonly unknown[],
  options: RemoteReconciliationOptions,
) {
  const serializedRemoteElements = serializeExcalidrawElements(remoteElements);
  const remoteIds = new Set(
    serializedRemoteElements.map(elementId).filter((id): id is string => id != null),
  );
  const publishedIds = new Set(options.lastPublishedIds);
  const serializedLocalElements = serializeExcalidrawElements(localElements).filter((element) => {
    const id = elementId(element);
    if (!id) return false;
    if (remoteIds.has(id)) return true;
    return options.isPointerDown
      && !options.seenRemoteIds.has(id)
      && !publishedIds.has(id);
  });
  return { localElements: serializedLocalElements, remoteElements: serializedRemoteElements };
}

const EXCALIDRAW_TOOL_BY_APP_TOOL: Record<string, string> = {
  select: 'selection',
  pen: 'freedraw',
  text: 'text',
  rectangle: 'rectangle',
  circle: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  stickyNote: 'rectangle',
  eraser: 'eraser',
};

const VALID_EXCALIDRAW_ELEMENT_TYPES = new Set([
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'text',
  'image',
  'frame',
  'magicframe',
  'iframe',
  'embeddable',
]);

export function toExcalidrawToolType(tool: string): string {
  return EXCALIDRAW_TOOL_BY_APP_TOOL[tool] ?? 'selection';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeExcalidrawElement(element: unknown): Record<string, unknown> | null {
  if (!isRecord(element) || typeof element.type !== 'string') {
    return null;
  }

  if (!VALID_EXCALIDRAW_ELEMENT_TYPES.has(element.type)) {
    return null;
  }

  return JSON.parse(JSON.stringify(element)) as Record<string, unknown>;
}

export function serializeExcalidrawElements(elements: readonly unknown[]): Record<string, unknown>[] {
  return elements
    .map((element) => serializeExcalidrawElement(element))
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

/**
 * Reconciles a server snapshot against the local scene, per element.
 *
 * The snapshot is written on a debounce, so it can be older than what the user
 * has just drawn. Replacing the scene with it wholesale therefore erases
 * unsaved work. Excalidraw stamps every element with a monotonic `version`, so
 * the newer of the two wins per id and local-only elements are always kept.
 */
export function reconcileElements(
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
    // Only take the remote copy when it is strictly newer, so a stale snapshot
    // can never roll back an element the user just changed.
    if (!current || elementVersion(element) > elementVersion(current)) {
      merged.set(id, element);
    }
  }

  return [...merged.values()];
}

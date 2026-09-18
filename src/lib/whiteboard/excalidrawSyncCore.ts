const EXCALIDRAW_TOOL_BY_APP_TOOL: Record<string, string> = {
  select: 'selection', pen: 'freedraw', text: 'text', rectangle: 'rectangle',
  circle: 'ellipse', line: 'line', arrow: 'arrow', stickyNote: 'rectangle', eraser: 'eraser',
};

const VALID_EXCALIDRAW_ELEMENT_TYPES = new Set([
  'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image',
  'frame', 'magicframe', 'iframe', 'embeddable', 'document',
]);

/*
 * A `document` element is one placed instance of an uploaded document
 * (EMBEDDED_DOCUMENTS_SPEC §4.3). It carries only bounded, non-secret
 * references and display state: element id, board id, instance id, document
 * id, shared page index, geometry, a version, and an optional bounded label.
 * The projection below is closed -- original bytes, page bytes, data URLs,
 * base64, download URLs, conversion diagnostics, page manifests, and per-page
 * image elements never survive serialization, and neither does any future
 * field this contract does not name.
 */
const DOCUMENT_ELEMENT_REFERENCE_KEYS = ['boardId', 'instanceId', 'documentId'] as const;
const DOCUMENT_ELEMENT_GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'angle'] as const;

function serializeDocumentElement(element: Record<string, unknown>): Record<string, unknown> | null {
  const id = element.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const key of DOCUMENT_ELEMENT_REFERENCE_KEYS) {
    const value = element[key];
    if (typeof value !== 'string' || value.length === 0) return null;
  }
  const sharedPageIndex = element.sharedPageIndex as number;
  if (!Number.isInteger(sharedPageIndex) || sharedPageIndex < 0) return null;
  for (const key of DOCUMENT_ELEMENT_GEOMETRY_KEYS) {
    const value = element[key] as number;
    if (!Number.isFinite(value)) return null;
  }
  const version = element.version as number;
  if (!Number.isInteger(version)) return null;

  const serialized: Record<string, unknown> = {
    id,
    type: 'document',
    boardId: element.boardId,
    instanceId: element.instanceId,
    documentId: element.documentId,
    sharedPageIndex,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    version,
  };
  if (typeof element.label === 'string') serialized.label = element.label;
  return serialized;
}

export function toExcalidrawToolType(tool: string): string {
  return EXCALIDRAW_TOOL_BY_APP_TOOL[tool] ?? 'selection';
}

/**
 * Whether this application has a tool of its own to name.
 *
 * Excalidraw's toolbar carries more than this map does -- diamond, image,
 * frame, the laser pointer -- and `toExcalidrawToolType` answers `selection`
 * for anything it does not know. That fallback is fine when the question is
 * "what should I show for the tool this app holds", and wrong when the answer
 * is about to be pushed back into the editor: choosing diamond would be
 * reported here, mapped to `selection`, and sent back, so the tool bounced to
 * the arrow a moment after it was picked.
 */
export function isMappedAppTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXCALIDRAW_TOOL_BY_APP_TOOL, tool);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeExcalidrawElement(element: unknown): Record<string, unknown> | null {
  if (!isRecord(element) || typeof element.type !== 'string') return null;
  if (!VALID_EXCALIDRAW_ELEMENT_TYPES.has(element.type)) return null;
  if (element.type === 'document') return serializeDocumentElement(element);
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

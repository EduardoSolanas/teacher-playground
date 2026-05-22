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

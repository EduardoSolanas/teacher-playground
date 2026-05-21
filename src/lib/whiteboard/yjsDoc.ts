import * as Y from 'yjs';
import type { CanvasElement } from '@/types/whiteboard';

export function createWhiteboardDoc(roomId: string) {
  const doc = new Y.Doc();

  const elementsArray = doc.getArray<Y.Map<any>>('elements');
  const viewportMap = doc.getMap('viewport');
  const cursorsMap = doc.getMap('cursors');

  return { doc, elementsArray, viewportMap, cursorsMap };
}

export function addElementToArray(
  elementsArray: Y.Array<Y.Map<any>>,
  element: CanvasElement
) {
  const yMap = new Y.Map();
  yMap.set('id', element.id);
  yMap.set('type', element.type);
  yMap.set('points', JSON.stringify((element as any).points || []));
  yMap.set('color', (element as any).color || '');
  yMap.set('strokeWidth', (element as any).strokeWidth || 2);
  yMap.set('x', (element as any).x || 0);
  yMap.set('y', (element as any).y || 0);
  yMap.set('width', (element as any).width || 0);
  yMap.set('height', (element as any).height || 0);
  yMap.set('text', (element as any).text || '');
  yMap.set('fontSize', (element as any).fontSize || 16);
  yMap.set('fontFamily', (element as any).fontFamily || 'sans-serif');
  yMap.set('bold', (element as any).bold || false);
  yMap.set('italic', (element as any).italic || false);
  yMap.set('fill', (element as any).fill || 'transparent');
  yMap.set('stroke', (element as any).stroke || '#000000');
  yMap.set('content', (element as any).content || '');
  yMap.set('backgroundColor', (element as any).backgroundColor || '#fff9c4');
  yMap.set('borderColor', (element as any).borderColor || '#000000');
  yMap.set('borderRadius', (element as any).borderRadius || 4);
  if ((element as { rotation?: number }).rotation != null) {
    yMap.set('rotation', (element as { rotation?: number }).rotation);
  }
  elementsArray.push([yMap]);
}

export function removeElementFromArray(
  elementsArray: Y.Array<Y.Map<any>>,
  elementId: string
) {
  const items = elementsArray.toArray();
  const index = items.findIndex((item) => item.get('id') === elementId);
  if (index !== -1) {
    elementsArray.delete(index, 1);
  }
}

export function updateElementInArray(
  elementsArray: Y.Array<Y.Map<any>>,
  elementId: string,
  updates: Partial<CanvasElement>
) {
  const items = elementsArray.toArray();
  const index = items.findIndex((item) => item.get('id') === elementId);
  if (index === -1) return;

  const yMap = items[index];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'points') {
      yMap.set(key, JSON.stringify(value || []));
    } else {
      yMap.set(key, value);
    }
  }
}

export function getElementsFromArray(
  elementsArray: Y.Array<Y.Map<any>>
): CanvasElement[] {
  const items = elementsArray.toArray();
  return items.map((yMap) => {
    const type = yMap.get('type') as CanvasElement['type'];
    const base = {
      id: yMap.get('id'),
      type,
      x: yMap.get('x'),
      y: yMap.get('y'),
      width: yMap.get('width'),
      height: yMap.get('height'),
      color: yMap.get('color'),
      strokeWidth: yMap.get('strokeWidth'),
      fill: yMap.get('fill'),
      stroke: yMap.get('stroke'),
      text: yMap.get('text'),
      fontSize: yMap.get('fontSize'),
      fontFamily: yMap.get('fontFamily'),
      bold: yMap.get('bold'),
      italic: yMap.get('italic'),
      content: yMap.get('content'),
      backgroundColor: yMap.get('backgroundColor'),
      borderColor: yMap.get('borderColor'),
      borderRadius: yMap.get('borderRadius'),
      rotation: yMap.get('rotation'),
    };

    if (type === 'pen' || type === 'line' || type === 'arrow') {
      const pointsStr = yMap.get('points');
      return { ...base, points: typeof pointsStr === 'string' ? JSON.parse(pointsStr) : pointsStr } as CanvasElement;
    }

    return base as CanvasElement;
  });
}

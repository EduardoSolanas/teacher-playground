import { describe, expect, it } from 'vitest';
import {
  excalidrawElementsEqual,
  serializeExcalidrawElement,
  serializeExcalidrawElements,
  toExcalidrawToolType,
} from './excalidrawSync';

describe('excalidraw sync helpers', () => {
  it('maps app tool ids to Excalidraw tool types', () => {
    expect(toExcalidrawToolType('select')).toBe('selection');
    expect(toExcalidrawToolType('pen')).toBe('freedraw');
    expect(toExcalidrawToolType('circle')).toBe('ellipse');
    expect(toExcalidrawToolType('unknown')).toBe('selection');
  });

  it('drops elements without a valid Excalidraw type', () => {
    expect(serializeExcalidrawElement({ id: 'bad' })).toBeNull();
    expect(serializeExcalidrawElement({ id: 'bad', type: 'pen' })).toBeNull();
    expect(serializeExcalidrawElements([
      { id: 'ok', type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] },
      { id: 'bad', type: undefined },
    ])).toHaveLength(1);
  });

  it('removes undefined object properties before writing to Yjs', () => {
    expect(serializeExcalidrawElement({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
      customData: undefined,
    })).toEqual({
      id: 'rect',
      type: 'rectangle',
      x: 0,
      y: 0,
    });
  });

  it('compares elements after serialization', () => {
    expect(excalidrawElementsEqual(
      [{ id: 'rect', type: 'rectangle', customData: undefined }],
      [{ id: 'rect', type: 'rectangle' }],
    )).toBe(true);
  });
});

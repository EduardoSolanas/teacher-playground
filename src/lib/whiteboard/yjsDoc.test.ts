import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import {
  createWhiteboardDoc,
  addElementToArray,
  removeElementFromArray,
  updateElementInArray,
  getElementsFromArray,
} from './yjsDoc';

describe('yjsDoc', () => {
  describe('createWhiteboardDoc', () => {
    it('creates a yjs document', () => {
      const { doc, elementsArray, viewportMap, cursorsMap } = createWhiteboardDoc('test-room');
      expect(doc).toBeInstanceOf(Y.Doc);
      expect(elementsArray).toBeInstanceOf(Y.Array);
      expect(viewportMap).toBeInstanceOf(Y.Map);
      expect(cursorsMap).toBeInstanceOf(Y.Map);
    });

    it('creates unique documents for different room IDs', () => {
      const doc1 = createWhiteboardDoc('room-a');
      const doc2 = createWhiteboardDoc('room-b');
      expect(doc1.doc).not.toBe(doc2.doc);
    });
  });

  describe('addElementToArray', () => {
    it('adds an element to the yjs array', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      const element = {
        id: 'el-1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        fill: '#ff0000',
        stroke: '#000000',
        strokeWidth: 2,
      } as any;

      addElementToArray(elementsArray, element);

      expect(elementsArray.length).toBe(1);
      const item = elementsArray.get(0);
      expect(item.get('id')).toBe('el-1');
      expect(item.get('type')).toBe('rectangle');
    });
  });

  describe('updateElementInArray', () => {
    it('updates an existing element', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      const element = {
        id: 'el-1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        fill: '#ff0000',
        stroke: '#000000',
        strokeWidth: 2,
      } as any;
      addElementToArray(elementsArray, element);

      updateElementInArray(elementsArray, 'el-1', { fill: '#00ff00', width: 200 } as any);

      const item = elementsArray.get(0);
      expect(item.get('fill')).toBe('#00ff00');
      expect(item.get('width')).toBe(200);
      expect(item.get('id')).toBe('el-1');
    });
  });

  describe('removeElementFromArray', () => {
    it('removes an element by id', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      const element = {
        id: 'el-1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        fill: '#ff0000',
        stroke: '#000000',
        strokeWidth: 2,
      } as any;
      addElementToArray(elementsArray, element);
      expect(elementsArray.length).toBe(1);

      removeElementFromArray(elementsArray, 'el-1');
      expect(elementsArray.length).toBe(0);
    });

    it('does nothing for non-existent id', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      removeElementFromArray(elementsArray, 'non-existent');
      expect(elementsArray.length).toBe(0);
    });
  });

  describe('getElementsFromArray', () => {
    it('returns elements from the yjs array', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      const element = {
        id: 'el-1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        fill: '#ff0000',
        stroke: '#000000',
        strokeWidth: 2,
      } as any;
      addElementToArray(elementsArray, element);

      const elements = getElementsFromArray(elementsArray);
      expect(elements).toHaveLength(1);
      expect((elements[0] as any).id).toBe('el-1');
      expect((elements[0] as any).type).toBe('rectangle');
    });

    it('handles multiple elements', () => {
      const { elementsArray } = createWhiteboardDoc('test-room');
      addElementToArray(elementsArray, {
        id: 'el-1',
        type: 'rectangle',
        x: 0, y: 0, width: 10, height: 10,
        fill: '#ff0000', stroke: '#000000', strokeWidth: 1,
      } as any);
      addElementToArray(elementsArray, {
        id: 'el-2',
        type: 'circle',
        x: 5, y: 5, width: 20, height: 20,
        fill: '#00ff00', stroke: '#000000', strokeWidth: 1,
      } as any);

      const elements = getElementsFromArray(elementsArray);
      expect(elements).toHaveLength(2);
      expect((elements[0] as any).id).toBe('el-1');
      expect((elements[1] as any).id).toBe('el-2');
    });
  });
});

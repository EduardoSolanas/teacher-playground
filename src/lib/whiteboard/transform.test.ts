import { describe, it, expect } from 'vitest';
import { getResizeHandle, resizeElement, rotateElement } from './transform';
import type { RectangleElement, CircleElement } from './types';

function createRect(x: number, y: number, w: number, h: number): RectangleElement {
  return {
    id: 'test',
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    fill: '#f00',
    stroke: '#000',
    strokeWidth: 1,
  };
}

function createCircle(x: number, y: number, w: number, h: number): CircleElement {
  return {
    id: 'test',
    type: 'circle',
    x,
    y,
    width: w,
    height: h,
    fill: '#0f0',
    stroke: '#000',
    strokeWidth: 1,
  };
}

describe('transform - resize', () => {
  it('resize element', () => {
    const el = createRect(0, 0, 100, 50);
    const handle = getResizeHandle(el, 100, 50);
    expect(handle).toBe('se');

    const updates = resizeElement(el, 'se', 150, 100, false);
    expect(updates.width).toBe(150);
    expect(updates.height).toBe(100);
  });

  it('aspect ratio maintained with shift key', () => {
    const el = createRect(0, 0, 100, 50);
    const handle = getResizeHandle(el, 100, 50);
    expect(handle).toBe('se');

    const updates = resizeElement(el, 'se', 200, 100, true);
    const aspectRatio = 100 / 50;
    const expectedWidth = 200;
    const expectedHeight = Math.round((expectedWidth / aspectRatio) * 100) / 100;
    expect(updates.width).toBe(200);
    expect(updates.height).toBe(expectedHeight);
  });

  it('resize from north handle', () => {
    const el = createRect(0, 0, 100, 50);
    const handle = getResizeHandle(el, 50, 0);
    expect(handle).toBe('n');

    const updates = resizeElement(el, 'n', 50, 25, false);
    expect(updates.height).toBe(25);
    expect(updates.y).toBe(25);
  });

  it('resize from west handle', () => {
    const el = createRect(0, 0, 100, 50);
    const handle = getResizeHandle(el, 0, 25);
    expect(handle).toBe('w');

    const updates = resizeElement(el, 'w', 50, 25, false);
    expect(updates.width).toBe(50);
    expect(updates.x).toBe(50);
  });

  it('no handle for pen element', () => {
    const el = {
      id: 'pen',
      type: 'pen' as const,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
      color: '#000',
      strokeWidth: 2,
    };
    const handle = getResizeHandle(el, 5, 5);
    expect(handle).toBeNull();
  });

  it('no handle when mouse is far from any handle', () => {
    const el = createRect(0, 0, 100, 50);
    const handle = getResizeHandle(el, 500, 500);
    expect(handle).toBeNull();
  });
});

describe('transform - rotate', () => {
  it('rotate element', () => {
    const el = createRect(0, 0, 100, 50);
    const updates = rotateElement(el, 100, 0, false);
    expect(updates.rotation).toBeDefined();
  });

  it('rotate with 15-degree increments', () => {
    const el = createRect(0, 0, 100, 50);
    const updates = rotateElement(el, 50, 50, true);
    expect(updates.rotation).toBeDefined();
    const degrees = updates.rotation as number;
    expect(degrees % 15).toBe(0);
  });

  it('rotate returns empty for pen element with single point', () => {
    const el = {
      id: 'pen',
      type: 'pen' as const,
      points: [{ x: 0, y: 0 }],
      color: '#000',
      strokeWidth: 2,
    };
    const updates = rotateElement(el, 10, 10, false);
    expect(updates).toEqual({});
  });
});

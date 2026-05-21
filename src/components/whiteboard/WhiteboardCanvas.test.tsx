import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('WhiteboardCanvas wiring', () => {
  const componentSource = readFileSync(
    resolve(__dirname, 'WhiteboardCanvas.tsx'),
    'utf-8'
  );

  it('accepts onCanvasMouseDown as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasMouseDown/);
  });

  it('accepts onCanvasMouseMove as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasMouseMove/);
  });

  it('accepts onCanvasMouseUp as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasMouseUp/);
  });

  it('accepts onCanvasClick as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasClick/);
  });

  it('accepts onCanvasDoubleClick as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasDoubleClick/);
  });

  it('accepts onCanvasContextMenu as a destructured prop', () => {
    expect(componentSource).toMatch(/onCanvasContextMenu/);
  });

  it('passes onCanvasMouseDown to internal handleStageMouseDown', () => {
    expect(componentSource).toMatch(/onCanvasMouseDown/);
    // Verify it's used in the event handler chain
    expect(componentSource).toMatch(/handleStageMouseDown.*onCanvasMouseDown|onCanvasMouseDown.*handleStageMouseDown/s);
  });

  it('passes onCanvasMouseMove to internal handleStageMouseMove', () => {
    expect(componentSource).toMatch(/handleStageMouseMove/);
    expect(componentSource).toMatch(/onCanvasMouseMove/);
  });

  it('passes onCanvasMouseUp to internal handleStageMouseUp', () => {
    expect(componentSource).toMatch(/handleStageMouseUp/);
    expect(componentSource).toMatch(/onCanvasMouseUp/);
  });

  it('passes onCanvasClick to handleClick', () => {
    expect(componentSource).toMatch(/handleClick/);
    expect(componentSource).toMatch(/onCanvasClick/);
  });

  it('passes onCanvasDoubleClick to handleDoubleClick', () => {
    expect(componentSource).toMatch(/handleDoubleClick/);
    expect(componentSource).toMatch(/onCanvasDoubleClick/);
  });

  it('passes onCanvasContextMenu to handleContextMenu', () => {
    expect(componentSource).toMatch(/handleContextMenu/);
    expect(componentSource).toMatch(/onCanvasContextMenu/);
  });

  it('binds handleStageMouseDown to Stage onMouseDown', () => {
    expect(componentSource).toMatch(/onMouseDown={handleStageMouseDown}/);
  });

  it('binds handleStageMouseMove to Stage onMouseMove', () => {
    expect(componentSource).toMatch(/onMouseMove={handleStageMouseMove}/);
  });

  it('binds handleStageMouseUp to Stage onMouseUp', () => {
    expect(componentSource).toMatch(/onMouseUp={handleStageMouseUp}/);
  });

  it('binds handleClick to Stage onClick', () => {
    expect(componentSource).toMatch(/onClick={handleClick}/);
  });

  it('binds handleDoubleClick to Stage onDblClick', () => {
    expect(componentSource).toMatch(/onDblClick={handleDoubleClick}/);
  });

  it('binds handleContextMenu to Stage onContextMenu', () => {
    expect(componentSource).toMatch(/onContextMenu={handleContextMenu}/);
  });
});

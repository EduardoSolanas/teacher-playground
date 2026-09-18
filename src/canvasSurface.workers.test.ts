import { describe, expect, it } from 'vitest';

/*
 * Milestone 0 spike tripwire (spec/DOCUMENTS_CONVERTER_SPIKE.md §4).
 *
 * This pins the empirical finding that workerd exposes no canvas surface:
 * candidate A (pdf.js inside a Worker) was rejected because there is no
 * pixel path. If this test ever fails because a toolchain upgrade SHIPS a
 * canvas surface, the spike must be re-opened before any pipeline code
 * relies on the old verdict — the failure is the signal, not a bug.
 */
describe('workerd canvas surface probe (spike tripwire)', () => {
  it('still exposes no canvas globals for in-worker pdf rendering', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    expect(typeof g.OffscreenCanvas).toBe('undefined');
    expect(typeof g.OffscreenCanvasRenderingContext2D).toBe('undefined');
    expect(typeof g.ImageData).toBe('undefined');
    expect(typeof g.createImageBitmap).toBe('undefined');
    if (typeof g.OffscreenCanvas === 'function') {
      // A shipped canvas surface re-opens the spike; make the failure loud.
      const canvas = new (g.OffscreenCanvas as new (w: number, h: number) => OffscreenCanvas)(10, 10);
      expect(canvas.getContext('2d')).toBeNull();
    }
  });
});

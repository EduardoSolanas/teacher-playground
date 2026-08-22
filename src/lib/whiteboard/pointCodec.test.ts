import { describe, expect, it } from 'vitest';
import { encodePoints, decodePoints } from './pointCodec';

const stroke = (n: number, shift = 0): number[][] =>
  Array.from({ length: n }, (_, i) => [i + shift, i * 2 + shift]);

describe('pointCodec', () => {
  describe('encodePoints', () => {
    it('returns null for non-array input', () => {
      expect(encodePoints(null)).toBe(null);
      expect(encodePoints(undefined)).toBe(null);
      expect(encodePoints('not an array')).toBe(null);
      expect(encodePoints({ points: [] })).toBe(null);
    });

    it('returns null for array containing non-pair entries', () => {
      expect(encodePoints([1, 2, 3])).toBe(null);
      expect(encodePoints([[1, 2], 3, [4, 5]])).toBe(null);
      expect(encodePoints([[1, 2], [3]])).toBe(null);
    });

    it('returns null for array with non-number coordinates', () => {
      expect(encodePoints([['a', 'b']])).toBe(null);
      expect(encodePoints([[1, 'two']])).toBe(null);
      expect(encodePoints([[true, false]])).toBe(null);
    });

    it('returns null for non-finite numbers (NaN, Infinity)', () => {
      expect(encodePoints([[Number.NaN, 0]])).toBe(null);
      expect(encodePoints([[0, Number.NaN]])).toBe(null);
      expect(encodePoints([[Number.POSITIVE_INFINITY, 0]])).toBe(null);
      expect(encodePoints([[0, Number.NEGATIVE_INFINITY]])).toBe(null);
    });

    it('encodes an empty array', () => {
      const encoded = encodePoints([]);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded).toBeTruthy();
    });

    it('encodes a simple stroke', () => {
      const points = [[0, 0], [1, 2], [2, 4]];
      const encoded = encodePoints(points);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded?.length).toBeGreaterThan(0);
    });

    it('encodes negative coordinates', () => {
      const points = [[-100.5, -50.25], [-99.5, -48.25]];
      const encoded = encodePoints(points);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });

    it('encodes large coordinates', () => {
      const points = [[10000, 20000], [10001, 20002]];
      const encoded = encodePoints(points);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });
  });

  describe('decodePoints', () => {
    it('returns null for non-Uint8Array, non-string, non-array input', () => {
      expect(decodePoints(null)).toBe(null);
      expect(decodePoints(undefined)).toBe(null);
      expect(decodePoints(123)).toBe(null);
      expect(decodePoints({})).toBe(null);
    });

    it('decodes legacy JSON string format', () => {
      const points = [[1.5, 2.5], [3.5, 4.5]];
      const jsonString = JSON.stringify(points);
      const decoded = decodePoints(jsonString);
      expect(decoded).toEqual(points);
    });

    it('decodes legacy plain array format', () => {
      const points = [[1, 2], [3, 4]];
      const decoded = decodePoints(points);
      expect(decoded).toEqual(points);
    });

    it('returns null for garbage bytes', () => {
      const garbage = new Uint8Array([255, 254, 253, 252]);
      expect(decodePoints(garbage)).toBe(null);
    });

    it('returns null for truncated buffer', () => {
      // A buffer with version byte but incomplete data
      const truncated = new Uint8Array([1]);
      expect(decodePoints(truncated)).toBe(null);
    });

    it('returns null for foreign version byte', () => {
      // Version byte of 2 when we only support 1
      const buf = new Uint8Array([2, 0, 0, 0]);
      expect(decodePoints(buf)).toBe(null);
    });

    it('decodes an empty plain array', () => {
      const decoded = decodePoints([]);
      expect(decoded).toEqual([]);
    });

    it('decodes an empty encoded point array', () => {
      const encoded = encodePoints([]);
      const decoded = decodePoints(encoded!);
      expect(decoded).toEqual([]);
    });
  });

  describe('round trip', () => {
    it('preserves simple coordinates', () => {
      const points = [[0, 0], [1.5, 2.5], [3.99, 4.01]];
      const encoded = encodePoints(points);
      const decoded = decodePoints(encoded!);
      expect(decoded).toEqual(points);
    });

    it('preserves coordinates to within 0.01 (quantization tolerance)', () => {
      const points = [[0, 0], [1.234, 2.567], [3.999, 4.001], [100.5555, 200.4444]];
      const encoded = encodePoints(points);
      const decoded = decodePoints(encoded!);

      expect(decoded).toHaveLength(points.length);
      for (let i = 0; i < points.length; i++) {
        expect(Math.abs(decoded![i][0] - points[i][0])).toBeLessThanOrEqual(0.01);
        expect(Math.abs(decoded![i][1] - points[i][1])).toBeLessThanOrEqual(0.01);
      }
    });

    it('encodes a 300-point stroke with strong compression', () => {
      const points = stroke(300);
      const encoded = encodePoints(points);
      const jsonSize = JSON.stringify(points).length;
      const encodedSize = encoded!.length;
      const ratio = encodedSize / jsonSize;

      /*
       * Roughly 4 bytes a point against JSON's ~9.5, and the arithmetic is
       * worth stating because it bounds what this can ever achieve.
       *
       * Coordinates are quantised to hundredths, so a 3px step between samples
       * becomes a delta of 300 — two varint bytes per coordinate, four per
       * point. Quantising to tenths instead would halve that again, at the
       * cost of a 0.1 scene-unit error: invisible at normal magnification,
       * but 3 screen pixels at Excalidraw's 30x zoom, on a board a tutor may
       * well zoom into. The precision was chosen first and the ratio follows
       * from it, not the other way round.
       */
      expect(ratio).toBeLessThan(0.45);
      expect(encodedSize).toBeGreaterThan(0);

      // Also verify decoded values match the original
      const decoded = decodePoints(encoded!);
      expect(decoded).toHaveLength(300);
      for (let i = 0; i < 300; i++) {
        expect(Math.abs(decoded![i][0] - points[i][0])).toBeLessThanOrEqual(0.01);
        expect(Math.abs(decoded![i][1] - points[i][1])).toBeLessThanOrEqual(0.01);
      }
    });

    it('preserves negative and large coordinates', () => {
      const points = [[-1000.5, -2000.25], [5000.99, 10000.01], [-0.01, 0.01]];
      const encoded = encodePoints(points);
      const decoded = decodePoints(encoded!);

      expect(decoded).toHaveLength(points.length);
      for (let i = 0; i < points.length; i++) {
        expect(Math.abs(decoded![i][0] - points[i][0])).toBeLessThanOrEqual(0.01);
        expect(Math.abs(decoded![i][1] - points[i][1])).toBeLessThanOrEqual(0.01);
      }
    });

    it('handles an empty array round trip', () => {
      const points: number[][] = [];
      const encoded = encodePoints(points);
      const decoded = decodePoints(encoded!);
      expect(decoded).toEqual([]);
    });

    it('handles a single point', () => {
      const points = [[42.5, 123.75]];
      const encoded = encodePoints(points);
      const decoded = decodePoints(encoded!);

      expect(decoded).toHaveLength(1);
      expect(Math.abs(decoded![0][0] - points[0][0])).toBeLessThanOrEqual(0.01);
      expect(Math.abs(decoded![0][1] - points[0][1])).toBeLessThanOrEqual(0.01);
    });
  });
});

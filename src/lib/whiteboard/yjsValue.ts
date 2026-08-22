/**
 * Comparing and copying element properties on the drawing hot path.
 *
 * `replaceSharedElements` walks every property of every element it is given and
 * asks "did this change" before writing. Both halves of that used to go through
 * JSON: a deep copy via `JSON.parse(JSON.stringify(value))`, and a comparison
 * via `JSON.stringify(left) === JSON.stringify(right)`. On a freedraw element
 * whose `points` array holds a few hundred pairs, that built and threw away two
 * large strings per property, per element, on every pointer sample.
 *
 * The replacements are exact, not approximate. Comparing strokes by length or
 * bounding box would be faster still and would silently lose drawings: two
 * strokes can share a point count and a bounding box and be different shapes,
 * and an "equal" answer means the change is never written and never syncs.
 * An element-wise loop that exits on the first difference beats serialising
 * both sides anyway, and cannot be wrong.
 */

/** Depth beyond which a structure is treated as cyclic rather than walked. */
const MAX_DEPTH = 64;

/**
 * Exact deep equality, bailing out at the first difference.
 *
 * NaN equals NaN here — via Object.is — because a coordinate that arrived as
 * NaN would otherwise never compare equal to itself and would republish the
 * element on every single sample, forever.
 */
export function valuesEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > MAX_DEPTH) return false;
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;

  if (leftIsArray) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }

  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!valuesEqual(a[key], b[key], depth + 1)) return false;
  }
  return true;
}

class CyclicValue extends Error {}

function clone(value: unknown, depth: number): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'undefined') return undefined;
  if (type !== 'object') return value;
  if (depth > MAX_DEPTH) throw new CyclicValue();

  if (Array.isArray(value)) {
    // JSON turned a hole, an undefined and a function into null; keep that, so
    // an element's shape does not change the day this stopped using JSON.
    return value.map((entry) => {
      const copied = clone(entry, depth + 1);
      return copied === undefined ? null : copied;
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const copied = clone(entry, depth + 1);
    // JSON dropped undefined members and functions rather than storing null.
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

/**
 * A detached copy safe to hand to the shared document.
 *
 * Returns undefined for anything that cannot be represented — the same answer
 * the JSON round trip gave when it threw.
 */
export function cloneForYjs(value: unknown): unknown {
  try {
    return clone(value, 0);
  } catch {
    return undefined;
  }
}

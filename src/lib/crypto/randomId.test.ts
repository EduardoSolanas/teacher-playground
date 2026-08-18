import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSPRNG_ID_BYTES, generateRoomId, randomHexId } from './randomId';

describe('CSPRNG identifiers (SEC-006)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws at least 128 bits from crypto.getRandomValues, not Math.random', () => {
    const math = vi.spyOn(Math, 'random').mockReturnValue(0);
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');

    const id = randomHexId();

    expect(math).not.toHaveBeenCalled();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const buf = getRandomValues.mock.calls[0][0] as Uint8Array;
    expect(buf.byteLength).toBeGreaterThanOrEqual(16);
    expect(CSPRNG_ID_BYTES).toBeGreaterThanOrEqual(16);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('monkey-patching Math.random cannot force colliding room ids', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const ids = new Set(Array.from({ length: 8 }, () => generateRoomId()));
    expect(ids.size).toBe(8);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { CSPRNG_ID_HEX_LENGTH } from '../crypto/randomId';
import { isValidRoomId } from '../worker/requestGuard';
import { isValidJoinCode } from './joinCode';

describe('isValidJoinCode', () => {
  it('accepts 32-char hex room ids like the server', () => {
    const hex32 = 'a'.repeat(CSPRNG_ID_HEX_LENGTH);
    expect(isValidJoinCode(hex32)).toBe(true);
    expect(isValidJoinCode(hex32)).toBe(isValidRoomId(hex32));
  });

  it('rejects path traversal, empty, and overlong codes', () => {
    expect(isValidJoinCode('../x')).toBe(false);
    expect(isValidJoinCode('')).toBe(false);
    expect(isValidJoinCode('a'.repeat(65))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  displayNameFromAccessClaims,
  roomNameForHostDisplayName,
  resolveJoinDisplayName,
} from './accessDisplayName';

describe('displayNameFromAccessClaims', () => {
  it('uses the IdP name claim (Google full name)', () => {
    expect(displayNameFromAccessClaims({
      name: 'Ada Lovelace',
      email: 'ada@gmail.com',
      sub: 'google-oidc|1',
    })).toBe('Ada Lovelace');
  });

  it('joins given_name and family_name when name is absent', () => {
    expect(displayNameFromAccessClaims({
      given_name: 'Ada',
      family_name: 'Lovelace',
      email: 'ada@gmail.com',
    })).toBe('Ada Lovelace');
  });

  it('never treats email as a display name', () => {
    expect(displayNameFromAccessClaims({
      email: 'ada@gmail.com',
      sub: 'google-oidc|1',
    })).toBeUndefined();
  });

  it('strips control characters and rejects an empty result', () => {
    expect(displayNameFromAccessClaims({ name: '\u0000\n\t' })).toBeUndefined();
    expect(displayNameFromAccessClaims({ name: 'Ada\u0000 Lovelace' })).toBe('Ada Lovelace');
  });
});

describe('roomNameForHostDisplayName', () => {
  it('names the room after the host without asking', () => {
    expect(roomNameForHostDisplayName('Ada Lovelace')).toBe("Ada Lovelace's room");
  });

  it('stays within the room name length bound', () => {
    const long = 'A'.repeat(100);
    expect(roomNameForHostDisplayName(long).length).toBeLessThanOrEqual(100);
  });
});

describe('resolveJoinDisplayName', () => {
  it('prefers a stored classroom label over the Access profile name', () => {
    expect(resolveJoinDisplayName({
      storedName: 'Ms Ada',
      accessDisplayName: 'Ada Lovelace',
    })).toBe('Ms Ada');
  });

  it('uses the Access profile name when nothing is stored', () => {
    expect(resolveJoinDisplayName({
      storedName: null,
      accessDisplayName: 'Ada Lovelace',
    })).toBe('Ada Lovelace');
  });
});

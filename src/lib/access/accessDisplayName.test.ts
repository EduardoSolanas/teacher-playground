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
      email: 'ada@example.test',
      sub: 'google-oidc|1',
    })).toBe('Ada Lovelace');
  });

  it('joins given_name and family_name when name is absent', () => {
    expect(displayNameFromAccessClaims({
      given_name: 'Ada',
      family_name: 'Lovelace',
      email: 'ada@example.test',
    })).toBe('Ada Lovelace');
  });

  it('never treats email as a display name', () => {
    expect(displayNameFromAccessClaims({
      email: 'ada@example.test',
      sub: 'google-oidc|1',
    })).toBeUndefined();
  });

  it('strips control characters and rejects an empty result', () => {
    expect(displayNameFromAccessClaims({ name: '\u0000\n\t' })).toBeUndefined();
    expect(displayNameFromAccessClaims({ name: 'Ada\u0000 Lovelace' })).toBe('Ada Lovelace');
  });

  it('accepts a name of exactly the maximum length and rejects one character more', () => {
    expect(displayNameFromAccessClaims({ name: 'A'.repeat(100) })).toBe('A'.repeat(100));
    expect(displayNameFromAccessClaims({ name: 'A'.repeat(101) })).toBeUndefined();
  });

  it('falls back to given and family names only when they survive sanitizing', () => {
    expect(displayNameFromAccessClaims({ given_name: 'Ada', family_name: '' })).toBe('Ada');
    expect(displayNameFromAccessClaims({ given_name: '', family_name: '' })).toBeUndefined();
    expect(displayNameFromAccessClaims({ given_name: 42, family_name: 'Lovelace' })).toBe('Lovelace');
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

  it('appends the suffix directly when the name plus suffix fits exactly', () => {
    expect(roomNameForHostDisplayName('A'.repeat(93))).toBe(`${'A'.repeat(93)}'s room`);
  });

  it('truncates a long name at the suffix boundary instead of the length bound', () => {
    expect(roomNameForHostDisplayName('A'.repeat(100))).toBe(`${'A'.repeat(93)}'s room`);
    expect(roomNameForHostDisplayName('A'.repeat(94))).toBe(`${'A'.repeat(93)}'s room`);
    expect(roomNameForHostDisplayName('A'.repeat(93) + 'Z').length).toBe(100);
  });

  it('trims the truncation seam without dropping the suffix', () => {
    const name = 'A'.repeat(92) + ' ' + 'B'.repeat(10);
    expect(roomNameForHostDisplayName(name)).toBe(`${'A'.repeat(92)}'s room`);
  });

  it('falls back to Classroom for empty names', () => {
    expect(roomNameForHostDisplayName('')).toBe("Classroom's room");
    expect(roomNameForHostDisplayName('\u0000 \n')).toBe("Classroom's room");
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

  it('falls back to the Access name when the stored label is only controls', () => {
    expect(resolveJoinDisplayName({
      storedName: '\u0000\t',
      accessDisplayName: 'Ada Lovelace',
    })).toBe('Ada Lovelace');
  });

  it('returns null when neither source yields a name', () => {
    expect(resolveJoinDisplayName({ storedName: null, accessDisplayName: null })).toBeNull();
    expect(resolveJoinDisplayName({ storedName: null, accessDisplayName: 'A'.repeat(101) })).toBeNull();
  });
});

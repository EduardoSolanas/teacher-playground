import { describe, expect, it } from 'vitest';
import {
  documentsAllowsWrites,
  documentsModeLabel,
  documentsSurfaceVisible,
  parseDocumentsMode,
  type DocumentsMode,
} from './documentsFlag';

describe('parseDocumentsMode', () => {
  it('defaults everything unrecognised to off, fail-closed', () => {
    const closed: Array<string | undefined> = [
      undefined,
      '',
      '   ',
      'off',
      'OFF',
      'false',
      '0',
      'disabled',
      'garbage',
      'true,',
    ];
    for (const value of closed) {
      expect(parseDocumentsMode(value)).toBe('off');
    }
  });

  it('parses the read-only kill switch in its spellings, case-insensitively', () => {
    expect(parseDocumentsMode('read-only')).toBe('read-only');
    expect(parseDocumentsMode('READ-ONLY')).toBe('read-only');
    expect(parseDocumentsMode(' readonly ')).toBe('read-only');
    expect(parseDocumentsMode('ro')).toBe('read-only');
  });

  it('parses the fully-enabled mode in its spellings, case-insensitively', () => {
    expect(parseDocumentsMode('on')).toBe('on');
    expect(parseDocumentsMode('ON')).toBe('on');
    expect(parseDocumentsMode(' true ')).toBe('on');
    expect(parseDocumentsMode('1')).toBe('on');
  });
});

describe('surface and write gating', () => {
  const modes: DocumentsMode[] = ['off', 'read-only', 'on'];

  it('hides the surface only when off', () => {
    expect(modes.filter((m) => documentsSurfaceVisible(m))).toEqual(['read-only', 'on']);
  });

  it('allows writes only when fully on — the kill switch leaves reads alive', () => {
    expect(modes.filter((m) => documentsAllowsWrites(m))).toEqual(['on']);
  });

  it('labels each mode for logs without leaking configuration', () => {
    expect(documentsModeLabel('off')).toBe('off');
    expect(documentsModeLabel('read-only')).toBe('read-only');
    expect(documentsModeLabel('on')).toBe('on');
  });
});

import { describe, expect, it } from 'vitest';
import { parseAdminEmails } from './adminGuard';
import { normalizeOperatorEmail } from '../company/operator';

describe('parseAdminEmails', () => {
  it('returns an empty set for an unset value', () => {
    expect(parseAdminEmails(undefined)).toEqual(new Set());
  });

  it('returns an empty set for an empty string', () => {
    expect(parseAdminEmails('')).toEqual(new Set());
  });

  it('normalizes entries through the operator rules (trim + lowercase)', () => {
    expect(parseAdminEmails('  Admin@Example.Test  ')).toEqual(
      new Set(['admin@example.test']),
    );
  });

  it('parses several comma-separated emails into one set', () => {
    expect(parseAdminEmails('Ada@Example.test, grace@example.test')).toEqual(
      new Set(['ada@example.test', 'grace@example.test']),
    );
  });

  it('skips empty and invalid entries instead of admitting them', () => {
    expect(
      parseAdminEmails(',, ada@example.test ,, not-an-email, @bad, trailing@'),
    ).toEqual(new Set(['ada@example.test']));
  });

  it('matches a candidate normalized the same way the guards normalize it', () => {
    // Set membership is exact: the guards normalize the candidate through the
    // same operator rule before checking, so the parsed list only has to agree
    // in form — which it does by construction.
    const admins = parseAdminEmails('ADMIN@Example.test');
    expect(normalizeOperatorEmail('ADMIN@Example.Test')).toBe('admin@example.test');
    expect(admins.has(normalizeOperatorEmail('ADMIN@Example.Test') ?? '')).toBe(true);
    expect(admins.has(normalizeOperatorEmail('outsider@example.test') ?? '')).toBe(false);
  });

  it('never admits a candidate that is not on the list', () => {
    expect(parseAdminEmails('admin@example.test').has('outsider@example.test')).toBe(false);
  });
});

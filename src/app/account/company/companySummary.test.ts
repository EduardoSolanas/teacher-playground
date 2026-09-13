import { describe, expect, it } from 'vitest';

import {
  inviteTokenHash,
  parseCompanySummary,
  readInviteToken,
  readMintedInvite,
} from './companySummary';

const COMPANY = { id: 'co_1', name: 'Acme Tutoring', role: 'owner', state: 'active' };
const SUBSCRIPTION = {
  quantity: 5,
  pendingQuantity: null,
  pendingOperationId: null,
  firstPaidAt: Date.UTC(2026, 0, 15),
  hostedInvoiceUrl: 'https://invoice.test/in_1',
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    company: { ...COMPANY },
    subscription: { ...SUBSCRIPTION },
    members: [],
    ...overrides,
  };
}

describe('parseCompanySummary', () => {
  it('rejects payloads that are not objects', () => {
    expect(parseCompanySummary(null)).toBeNull();
    expect(parseCompanySummary(undefined)).toBeNull();
    expect(parseCompanySummary('company')).toBeNull();
    expect(parseCompanySummary(0)).toBeNull();
  });

  it('rejects a missing, array, or malformed company record', () => {
    expect(parseCompanySummary({})).toBeNull();
    expect(parseCompanySummary({ company: null })).toBeNull();
    expect(parseCompanySummary({ company: [] })).toBeNull();
    expect(parseCompanySummary({ company: { ...COMPANY, id: 7 } })).toBeNull();
    expect(parseCompanySummary({ company: { ...COMPANY, name: null } })).toBeNull();
  });

  it('rejects an unknown company role', () => {
    expect(parseCompanySummary(payload({ company: { ...COMPANY, role: 'ghost' } }))).toBeNull();
  });

  it('rejects a subscription that is not an object or carries no usable quantity', () => {
    expect(parseCompanySummary(payload({ subscription: [] }))).toBeNull();
    expect(parseCompanySummary(payload({ subscription: false }))).toBeNull();
    expect(parseCompanySummary(payload({ subscription: {} }))).toBeNull();
    expect(parseCompanySummary(payload({ subscription: { ...SUBSCRIPTION, quantity: 0 } }))).toBeNull();
    expect(
      parseCompanySummary(payload({ subscription: { ...SUBSCRIPTION, quantity: 2.5 } })),
    ).toBeNull();
  });

  it('defaults capacity and billing state when there is no subscription', () => {
    const summary = parseCompanySummary({
      company: { ...COMPANY },
      members: [],
    });

    expect(summary).not.toBeNull();
    expect(summary?.capacity).toBe(1);
    expect(summary?.pendingSeats).toBeNull();
    expect(summary?.awaitingPayment).toBe(false);
    expect(summary?.hostedInvoiceUrl).toBeNull();
    expect(summary?.members).toEqual([]);
  });

  it('defaults the member list when the payload omits it', () => {
    const summary = parseCompanySummary({
      company: { ...COMPANY },
      subscription: { ...SUBSCRIPTION },
    });

    expect(summary?.members).toEqual([]);
  });

  it('drops member entries that are not valid member records', () => {
    const summary = parseCompanySummary(
      payload({
        members: [
          null,
          'not-a-member',
          { accountId: '', role: 'member' },
          { accountId: 'acc_bad_role', role: 'ghost' },
          { accountId: 'acc_no_date', role: 'member', createdAt: 'yesterday' },
          { accountId: 'acc_admin', role: 'admin', createdAt: 7, preferredDisplayName: 'Ada' },
          { accountId: 'acc_blank_name', role: 'member', createdAt: 8, preferredDisplayName: '  ' },
        ],
      }),
    );

    expect(summary?.members).toEqual([
      { accountId: 'acc_no_date', displayName: null, role: 'member', joinedAt: null },
      { accountId: 'acc_admin', displayName: 'Ada', role: 'admin', joinedAt: 7 },
      { accountId: 'acc_blank_name', displayName: null, role: 'member', joinedAt: 8 },
    ]);
  });

  it('reports a disabled company state', () => {
    const summary = parseCompanySummary(
      payload({ company: { ...COMPANY, state: 'disabled' } }),
    );

    expect(summary?.state).toBe('disabled');
  });

  it('reports the lower of the current and pending quantities as capacity', () => {
    const shrinking = parseCompanySummary(
      payload({ subscription: { ...SUBSCRIPTION, quantity: 5, pendingQuantity: 3, pendingOperationId: 'op_1' } }),
    );
    const growing = parseCompanySummary(
      payload({ subscription: { ...SUBSCRIPTION, quantity: 5, pendingQuantity: 9, pendingOperationId: 'op_2' } }),
    );

    expect(shrinking?.capacity).toBe(3);
    expect(shrinking?.pendingSeats).toEqual({ quantity: 3, operationId: 'op_1' });
    expect(growing?.capacity).toBe(5);
    expect(growing?.pendingSeats).toEqual({ quantity: 9, operationId: 'op_2' });
  });

  it('treats a pending quantity without an operation id as not pending', () => {
    const summary = parseCompanySummary(
      payload({ subscription: { ...SUBSCRIPTION, quantity: 5, pendingQuantity: 8, pendingOperationId: null } }),
    );

    expect(summary?.capacity).toBe(5);
    expect(summary?.pendingSeats).toBeNull();
  });

  it('falls back to no invoice link and awaiting payment before the first payment', () => {
    const summary = parseCompanySummary(
      payload({
        subscription: {
          ...SUBSCRIPTION,
          firstPaidAt: null,
          hostedInvoiceUrl: '',
        },
      }),
    );

    expect(summary?.awaitingPayment).toBe(true);
    expect(summary?.hostedInvoiceUrl).toBeNull();
  });
});

describe('readInviteToken', () => {
  it('accepts a URL-safe token from a fragment or a bare hash string', () => {
    expect(readInviteToken('#invite=abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(readInviteToken('invite=abc123')).toBe('abc123');
  });

  it('rejects missing, empty, or unsafe tokens', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#other=abc123')).toBeNull();
    expect(readInviteToken('#invite=')).toBeNull();
    expect(readInviteToken('#invite=bad%20token')).toBeNull();
  });
});

describe('readMintedInvite', () => {
  const hash = 'a'.repeat(64);

  it('rejects payloads without a valid token', () => {
    expect(readMintedInvite(null)).toBeNull();
    expect(readMintedInvite([])).toBeNull();
    expect(readMintedInvite({})).toBeNull();
    expect(readMintedInvite({ token: 'bad token!' })).toBeNull();
    expect(readMintedInvite({ token: 12 })).toBeNull();
  });

  it('keeps a valid hash and drops an invalid one', () => {
    expect(readMintedInvite({ token: 'good_token', inviteHash: hash })).toEqual({
      token: 'good_token',
      inviteHash: hash,
    });
    expect(readMintedInvite({ token: 'good_token', inviteHash: 'nope' })).toEqual({
      token: 'good_token',
      inviteHash: null,
    });
    expect(readMintedInvite({ token: 'good_token' })).toEqual({
      token: 'good_token',
      inviteHash: null,
    });
  });
});

describe('inviteTokenHash', () => {
  it('returns the lowercase SHA-256 hex digest of the token', async () => {
    const expected = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode('join_token'))
      .then((digest) =>
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );

    await expect(inviteTokenHash('join_token')).resolves.toBe(expected);
  });
});

import { describe, expect, it } from 'vitest';
import { shouldStartCollaboration } from './collaborationGate';

describe('shouldStartCollaboration', () => {
  it('does not start for pending access or waiting peers', () => {
    expect(
      shouldStartCollaboration({
        roomGranted: false,
        accessStatus: 'pending',
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(false);

    expect(
      shouldStartCollaboration({
        roomGranted: true,
        accessStatus: 'approved',
        grantRole: 'peer',
        isWaiting: true,
        wasKicked: false,
      }),
    ).toBe(false);
  });

  it('does not start for kicked peers', () => {
    expect(
      shouldStartCollaboration({
        roomGranted: true,
        accessStatus: 'approved',
        grantRole: 'creator',
        isWaiting: false,
        wasKicked: true,
      }),
    ).toBe(false);
  });

  it('starts after GET /room succeeds for a granted peer', () => {
    expect(
      shouldStartCollaboration({
        roomGranted: true,
        accessStatus: 'approved',
        grantRole: 'peer',
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(true);
  });

  it('starts when access is approved with a granted role before room load', () => {
    expect(
      shouldStartCollaboration({
        roomGranted: false,
        accessStatus: 'approved',
        grantRole: 'viewer',
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(true);
  });

  it('does not start for rejected, none, or unapproved access', () => {
    expect(
      shouldStartCollaboration({
        roomGranted: false,
        accessStatus: 'rejected',
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(false);

    expect(
      shouldStartCollaboration({
        roomGranted: false,
        accessStatus: 'none',
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(false);

    expect(
      shouldStartCollaboration({
        roomGranted: false,
        accessStatus: 'approved',
        grantRole: null,
        isWaiting: false,
        wasKicked: false,
      }),
    ).toBe(false);
  });
});

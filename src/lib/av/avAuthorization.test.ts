import { describe, expect, it } from 'vitest';

import {
  avEligible,
  avEligibilityStatus,
  isAdmittedRole,
  roleFromValue,
} from './avAuthorization';

describe('isAdmittedRole', () => {
  it('admits owner, editor, viewer, and legacy member', () => {
    expect(isAdmittedRole('owner')).toBe(true);
    expect(isAdmittedRole('editor')).toBe(true);
    expect(isAdmittedRole('viewer')).toBe(true);
    expect(isAdmittedRole('member')).toBe(true);
  });
  it('rejects pending, waiting, banned, and unknown', () => {
    expect(isAdmittedRole('pending')).toBe(false);
    expect(isAdmittedRole('waiting')).toBe(false);
    expect(isAdmittedRole('banned')).toBe(false);
    expect(isAdmittedRole('unknown')).toBe(false);
    expect(isAdmittedRole(null)).toBe(false);
  });
});

describe('roleFromValue', () => {
  it('maps values to roles', () => {
    expect(roleFromValue('owner')).toBe('owner');
    expect(roleFromValue('member')).toBe('member');
    expect(roleFromValue('editor')).toBe('editor');
    expect(roleFromValue('pending')).toBe('pending');
    expect(roleFromValue('waiting')).toBe('waiting');
    expect(roleFromValue(undefined)).toBe('unknown');
  });
});

describe('avEligible', () => {
  it('is eligible for admitted participants', () => {
    expect(avEligible('owner').eligible).toBe(true);
    expect(avEligible('member').eligible).toBe(true);
    expect(avEligible('editor').eligible).toBe(true);
    expect(avEligible('viewer').eligible).toBe(true);
    expect(avEligible('owner').reason).toBe('admitted');
  });
  it('is not eligible for waiting participants', () => {
    const result = avEligible('waiting');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('waiting');
  });
  it('is not eligible for non-members', () => {
    expect(avEligible('unknown').eligible).toBe(false);
    expect(avEligible(null).reason).toBe('not-a-member');
  });
  it('is not eligible for banned accounts', () => {
    const result = avEligible('banned');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not-a-member');
  });
});

describe('avEligibilityStatus', () => {
  it('returns 403 for ineligible participants', () => {
    expect(avEligibilityStatus(false, true)).toBe(403);
  });
  it('returns 503 when the provider is unconfigured', () => {
    expect(avEligibilityStatus(true, false)).toBe(503);
    expect(avEligibilityStatus(false, false)).toBe(503);
  });
  it('returns 200 for eligible configured participants', () => {
    expect(avEligibilityStatus(true, true)).toBe(200);
  });
});

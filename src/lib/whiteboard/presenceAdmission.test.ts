import { describe, expect, it } from 'vitest';
import { admissionFromPresenceStatus } from './presenceAdmission';

describe('admissionFromPresenceStatus', () => {
  it('treats a missing room or full queue as waiting, not a live board', () => {
    expect(admissionFromPresenceStatus(404)).toBe('waiting');
    expect(admissionFromPresenceStatus(429)).toBe('waiting');
  });

  it('treats 403 as rejection', () => {
    expect(admissionFromPresenceStatus(403)).toBe('rejected');
  });

  it('treats 2xx as a successful presence write', () => {
    expect(admissionFromPresenceStatus(200)).toBe('ok');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAuthEvent, type AuthEventInput } from './authEvents';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logAuthEvent', () => {
  it('writes structured JSON with type and outcome', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'auth_failure',
        roomId: 'room-abc123',
        outcome: 'denied',
        reason: 'missing session',
      },
      (line) => lines.push(line),
    );

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!);
    expect(logged).toMatchObject({
      event: 'auth_event',
      type: 'auth_failure',
      roomId: 'room-abc123',
      outcome: 'denied',
      reason: 'missing session',
    });
  });

  it('never logs Authorization values, bearer tokens, cookies, or emails', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'grant_change',
        accountId: 'acct-1',
        roomId: 'room-1',
        outcome: 'granted',
        reason: [
          'Authorization: Bearer ' + JWT,
          'Cookie: CF_Authorization=' + JWT,
          'contact teacher@school.edu',
        ].join('; '),
      },
      (line) => lines.push(line),
    );

    const serialized = lines[0]!;
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('teacher@school.edu');
    expect(serialized).not.toMatch(/Bearer\s+eyJ/i);

    const logged = JSON.parse(serialized);
    expect(logged.type).toBe('grant_change');
    expect(logged.outcome).toBe('granted');
    expect(JSON.stringify(logged)).not.toContain('teacher@school.edu');
    expect(JSON.stringify(logged)).not.toMatch(/Bearer\s+eyJ/i);
  });

  it('redacts email-shaped accountId values', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'revocation',
        accountId: 'teacher@school.edu',
        outcome: 'revoked',
      },
      (line) => lines.push(line),
    );

    const serialized = lines[0]!;
    expect(serialized).not.toContain('teacher@school.edu');
    const logged = JSON.parse(serialized);
    expect(logged.accountId).not.toBe('teacher@school.edu');
    expect(logged.type).toBe('revocation');
    expect(logged.outcome).toBe('revoked');
  });

  it('covers all auth event types', () => {
    const types: AuthEventInput['type'][] = [
      'auth_failure',
      'grant_change',
      'revocation',
      'rate_limit',
      'socket_close',
    ];
    const lines: string[] = [];

    for (const type of types) {
      logAuthEvent({ type, outcome: 'ok' }, (line) => lines.push(line));
    }

    expect(lines).toHaveLength(types.length);
    lines.forEach((line, index) => {
      const logged = JSON.parse(line);
      expect(logged.type).toBe(types[index]);
      expect(logged.outcome).toBe('ok');
    });
  });

  it('defaults to console.info for the structured log line', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logAuthEvent({ type: 'rate_limit', outcome: 'blocked' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      event: 'auth_event',
      type: 'rate_limit',
      outcome: 'blocked',
    });
  });
});

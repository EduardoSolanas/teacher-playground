import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERIC_INTERNAL_ERROR,
  internalErrorResponse,
  redactForLog,
  serializeInternalError,
} from './safeError';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const BOARD_JSON = '{"elements":[{"id":"el-1","type":"rectangle","x":1}],"appState":{}}';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redactForLog', () => {
  it('redacts emails, bearer tokens, JWTs, and board JSON', () => {
    const raw = [
      'failed for teacher@example.com',
      `Authorization: Bearer ${JWT}`,
      `token=${JWT}`,
      `board=${BOARD_JSON}`,
    ].join(' ');

    const redacted = redactForLog(raw);

    expect(redacted).not.toContain('teacher@example.com');
    expect(redacted).not.toContain(JWT);
    expect(redacted).not.toContain('el-1');
    expect(redacted).toContain('[REDACTED_EMAIL]');
    expect(redacted).toContain('[REDACTED_TOKEN]');
    expect(redacted).toContain('[REDACTED_BOARD]');
  });
});

describe('serializeInternalError', () => {
  it('emits a structured log object with a redacted message', () => {
    const entry = serializeInternalError(
      new Error(`SQLITE_ERROR for teacher@example.com Bearer ${JWT} ${BOARD_JSON}`),
      'handleRoomGet',
    );

    expect(entry).toEqual({
      event: 'internal_error',
      op: 'handleRoomGet',
      name: 'Error',
      message: expect.any(String),
    });
    expect(entry.message).toContain('SQLITE_ERROR');
    expect(JSON.stringify(entry)).not.toContain('teacher@example.com');
    expect(JSON.stringify(entry)).not.toContain(JWT);
    expect(JSON.stringify(entry)).not.toContain('el-1');
  });
});

describe('internalErrorResponse', () => {
  it('returns a generic 500 body and logs redacted JSON', async () => {
    const lines: string[] = [];
    const response = internalErrorResponse(
      new Error(`password=super-secret token=${JWT} teacher@example.com ${BOARD_JSON}`),
      'handleRoomPost',
      (line) => lines.push(line),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: GENERIC_INTERNAL_ERROR });
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain(JWT);
    expect(JSON.stringify(body)).not.toContain('teacher@example.com');

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!);
    expect(logged.event).toBe('internal_error');
    expect(logged.op).toBe('handleRoomPost');
    expect(JSON.stringify(logged)).not.toContain('super-secret');
    expect(JSON.stringify(logged)).not.toContain(JWT);
    expect(JSON.stringify(logged)).not.toContain('teacher@example.com');
    expect(JSON.stringify(logged)).not.toContain('el-1');
  });

  it('defaults to console.error for the structured log line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    internalErrorResponse(new Error('disk full'), 'handleRoomDelete');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      event: 'internal_error',
      op: 'handleRoomDelete',
      message: 'disk full',
    });
  });
});

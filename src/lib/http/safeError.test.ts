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

describe('redactForLog secret assignment hardening', () => {
  it('redacts unseparated, dashed, and underscored api keys and leaves lookalikes alone', () => {
    expect(redactForLog('apikey=abc')).toBe('[REDACTED]');
    expect(redactForLog('api-key=abc')).toBe('[REDACTED]');
    expect(redactForLog('api_key=abc')).toBe('[REDACTED]');
    expect(redactForLog('apiXkey=abc')).toBe('apiXkey=abc');
  });

  it('redacts assignments with spaces around the separator', () => {
    expect(redactForLog('password : super-secret')).toBe('password : [REDACTED]');
    expect(redactForLog('token= abc')).toBe('token= [REDACTED]');
    expect(redactForLog('token=abc')).toBe('[REDACTED]');
  });
});

describe('redactForLog token hardening', () => {
  it('redacts a bare JWT with an exact replacement', () => {
    expect(redactForLog(`assertion ${JWT}`)).toBe('assertion [REDACTED_TOKEN]');
  });

  it('redacts a bearer token with an exact replacement', () => {
    expect(redactForLog('Bearer sekret123')).toBe('Bearer [REDACTED_TOKEN]');
    expect(redactForLog('Bearer  sekret123')).toBe('Bearer [REDACTED_TOKEN]');
  });

  it('redacts board JSON with attribute spacing', () => {
    expect(redactForLog('{"elements" : []}')).toBe('{"elements":"[REDACTED_BOARD]"}');
    expect(redactForLog('{"elements": []}')).toBe('{"elements":"[REDACTED_BOARD]"}');
    expect(redactForLog('{"elements": [ {"id":"el-1"} ]}')).toBe('{"elements":"[REDACTED_BOARD]"}');
  });
});

describe('serializeInternalError', () => {
  it('handles a non-Error rejection with the generic Error name', () => {
    expect(serializeInternalError('disk on fire', 'handleRoomPut')).toEqual({
      event: 'internal_error',
      op: 'handleRoomPut',
      name: 'Error',
      message: 'disk on fire',
    });
  });

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

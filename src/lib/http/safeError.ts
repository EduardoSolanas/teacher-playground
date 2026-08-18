export const GENERIC_INTERNAL_ERROR = 'Internal server error';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
const SECRET_ASSIGN_RE =
  /\b(?:password|secret|token|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/gi;
const BOARD_ELEMENTS_RE = /"elements"\s*:\s*\[[\s\S]{0,50000}?\]/g;

export type InternalErrorLog = {
  event: 'internal_error';
  op: string;
  name: string;
  message: string;
};

export function redactForLog(value: string): string {
  return value
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(BEARER_RE, 'Bearer [REDACTED_TOKEN]')
    .replace(JWT_RE, '[REDACTED_TOKEN]')
    .replace(SECRET_ASSIGN_RE, (match) => match.replace(/\S+$/, '[REDACTED]'))
    .replace(BOARD_ELEMENTS_RE, '"elements":"[REDACTED_BOARD]"');
}

export function serializeInternalError(error: unknown, op: string): InternalErrorLog {
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  return {
    event: 'internal_error',
    op,
    name,
    message: redactForLog(raw),
  };
}

export function internalErrorResponse(
  error: unknown,
  op: string,
  write: (line: string) => void = (line) => console.error(line),
): Response {
  write(JSON.stringify(serializeInternalError(error, op)));
  return Response.json({ error: GENERIC_INTERNAL_ERROR }, { status: 500 });
}

export type AuthEventType =
  | 'auth_failure'
  | 'grant_change'
  | 'revocation'
  | 'rate_limit'
  | 'socket_close';

export type AuthEventInput = {
  type: AuthEventType;
  accountId?: string;
  roomId?: string;
  outcome: string;
  reason?: string;
};

export type AuthEventLog = {
  event: 'auth_event';
  type: AuthEventType;
  accountId?: string;
  roomId?: string;
  outcome: string;
  reason?: string;
};

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const EMAIL_INLINE_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
const COOKIE_RE = /(?:^|[Cc]ookie:\s*)(?:[A-Za-z0-9_-]+=[^;\s]+)/g;
const WHOLE_JWT_RE = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const WHOLE_BEARER_RE = /^Bearer\s+\S+$/i;
const WHOLE_COOKIE_RE = /^(?:[A-Za-z0-9_-]+=.*|[Cc]ookie:\s*.+)$/;

function hashSensitiveValue(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `[REDACTED:${hash.toString(16)}]`;
}

function redactSensitiveAuthContent(value: string): string {
  return value
    .replace(EMAIL_INLINE_RE, '[REDACTED_EMAIL]')
    .replace(BEARER_RE, 'Bearer [REDACTED_TOKEN]')
    .replace(JWT_RE, '[REDACTED_TOKEN]')
    .replace(COOKIE_RE, '[REDACTED_COOKIE]');
}

function sanitizeField(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    EMAIL_RE.test(trimmed) ||
    WHOLE_JWT_RE.test(trimmed) ||
    WHOLE_BEARER_RE.test(trimmed) ||
    WHOLE_COOKIE_RE.test(trimmed)
  ) {
    return hashSensitiveValue(trimmed);
  }
  return redactSensitiveAuthContent(trimmed);
}

export function serializeAuthEvent(input: AuthEventInput): AuthEventLog {
  const entry: AuthEventLog = {
    event: 'auth_event',
    type: input.type,
    outcome: sanitizeField(input.outcome) ?? input.outcome,
  };

  const accountId = sanitizeField(input.accountId);
  if (accountId !== undefined) {
    entry.accountId = accountId;
  }

  const roomId = sanitizeField(input.roomId);
  if (roomId !== undefined) {
    entry.roomId = roomId;
  }

  const reason = sanitizeField(input.reason);
  if (reason !== undefined) {
    entry.reason = reason;
  }

  return entry;
}

export function logAuthEvent(
  input: AuthEventInput,
  write: (line: string) => void = (line) => console.info(line),
): void {
  write(JSON.stringify(serializeAuthEvent(input)));
}

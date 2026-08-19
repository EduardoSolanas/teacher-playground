import { MAX_NAME_LENGTH, stripAsciiControls } from '../whiteboard/requestSchemas';

function sanitizeProfileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = stripAsciiControls(value);
  if (!cleaned || cleaned.length > MAX_NAME_LENGTH) return undefined;
  return cleaned;
}

/**
 * Profile label from a verified Access JWT. Email is never a name and never
 * participates in account lookup.
 */
export function displayNameFromAccessClaims(
  claims: Record<string, unknown> | JwtNameClaims,
): string | undefined {
  const named = sanitizeProfileName(claims.name);
  if (named) return named;
  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';
  return sanitizeProfileName(`${given} ${family}`);
}

interface JwtNameClaims {
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  email?: unknown;
}

export function roomNameForHostDisplayName(displayName: string): string {
  const suffix = "'s room";
  const cleaned = stripAsciiControls(displayName) || 'Classroom';
  if (cleaned.length + suffix.length <= MAX_NAME_LENGTH) {
    return `${cleaned}${suffix}`;
  }
  const kept = cleaned.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length)).trim();
  return `${kept}${suffix}`.slice(0, MAX_NAME_LENGTH);
}

export function resolveJoinDisplayName(input: {
  storedName: string | null;
  accessDisplayName: string | null | undefined;
}): string | null {
  const stored = sanitizeProfileName(input.storedName ?? undefined);
  if (stored) return stored;
  return sanitizeProfileName(input.accessDisplayName ?? undefined) ?? null;
}

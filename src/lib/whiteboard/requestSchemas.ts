import { z } from 'zod';

/**
 * Request body schemas (SEC-005): every field is validated and bounded at the
 * boundary so malformed or oversized payloads are rejected before persistence.
 */

export const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ACCOUNT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const MAX_NAME_LENGTH = 100;
export const MAX_ELEMENTS = 10_000;
export const MAX_MAX_USERS = 10;

export const ROOM_SCENE_KEYS = ['elements', 'viewport'] as const;
export const ROOM_SETTINGS_KEYS = ['maxUsers', 'name', 'hostPeerId', 'allowFirstUserHost'] as const;

function hasOwnKeys(body: object | null, keys: readonly string[]): boolean {
  if (!body) return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

/** Creator-only fields; scene writes must not carry these. */
export function hasRoomSettingsIntent(body: object | null): boolean {
  return hasOwnKeys(body, ROOM_SETTINGS_KEYS);
}

/** Canvas fields; settings writes must not carry these. */
export function hasRoomSceneIntent(body: object | null): boolean {
  return hasOwnKeys(body, ROOM_SCENE_KEYS);
}

export const roomSceneSchema = z.object({
  elements: z.array(z.unknown()).max(MAX_ELEMENTS).optional(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite(),
  }).optional(),
});

export const roomSettingsSchema = z.object({
  maxUsers: z.number().int().min(1).max(MAX_MAX_USERS).optional(),
  hostPeerId: z.string().regex(PEER_ID_RE).optional(),
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  allowFirstUserHost: z.boolean().optional(),
});

export const roomPostSchema = roomSceneSchema;

export const presencePostSchema = z.object({
  action: z.enum(['kick', 'suspend']).optional(),
  peerId: z.string().regex(PEER_ID_RE).optional(),
  accountId: z.string().regex(ACCOUNT_ID_RE).optional(),
  userName: z.string().max(MAX_NAME_LENGTH).optional(),
  color: z.string().regex(COLOR_RE).optional(),
}).superRefine((data, ctx) => {
  const hasTarget = Boolean(data.peerId || data.accountId);
  if (data.action === 'kick' || data.action === 'suspend') {
    if (!hasTarget) {
      ctx.addIssue({ code: 'custom', message: 'accountId or peerId is required' });
    }
    return;
  }
  if (!data.peerId) {
    ctx.addIssue({ code: 'custom', message: 'peerId is required' });
  }
});

export const waitingPostSchema = z.object({
  peerId: z.string().regex(PEER_ID_RE).optional(),
  accountId: z.string().regex(ACCOUNT_ID_RE).optional(),
  action: z.enum(['approve', 'reject']),
}).refine((data) => Boolean(data.peerId || data.accountId), {
  message: 'accountId or peerId is required',
});

export const requestsPostSchema = z.object({
  userName: z.string().min(1).max(MAX_NAME_LENGTH),
  email: z.email().optional(),
});

export const requestActionPostSchema = z.object({
  action: z.enum(['approve', 'deny']),
  role: z.enum(['peer', 'viewer']).optional(),
});

/**
 * Parses a request body through a schema, adapting Zod's v4 result to the
 * `{ ok, data | error }` shape the request handlers consume.
 */
export type ParseOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): ParseOutcome<z.output<S>> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
}

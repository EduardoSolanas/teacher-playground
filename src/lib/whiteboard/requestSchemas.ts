import { z } from 'zod';

/**
 * Request body schemas (SEC-005): every field is validated and bounded at the
 * boundary so malformed or oversized payloads are rejected before persistence.
 */

export const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ELEMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const ACCOUNT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const MAX_NAME_LENGTH = 100;
export const MAX_ELEMENTS = 10_000;
export const MAX_ELEMENT_TYPE_LENGTH = 128;
export const MAX_ELEMENT_STRING_LENGTH = 4096;
export const MAX_ELEMENT_KEYS = 64;
export const MAX_ELEMENT_NEST_DEPTH = 10;
export const MAX_MAX_USERS = 10;

/** Excalidraw embed/media types that must not persist unless explicitly allowlisted. */
export const BLOCKED_ELEMENT_TYPES = new Set([
  'iframe',
  'embeddable',
  'magicframe',
  'image',
]);

/** U+0000–U+001F and U+007F — stripped from display and room names (SEC-017). */
const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
/** Zero-width / BOM — stripped so names cannot hide homoglyphs (SEC-017). */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
/** Confusable whitespace collapsed to a single space after stripping (SEC-017). */
const WHITESPACE_RE = /\s+/g;

export function stripAsciiControls(value: string): string {
  return value
    .replace(ASCII_CONTROL_RE, '')
    .replace(ZERO_WIDTH_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

const normalizedNameBase = z.preprocess(
  (val) => (typeof val === 'string' ? stripAsciiControls(val) : val),
  z.string().min(1).max(MAX_NAME_LENGTH),
);

export const ROOM_SCENE_KEYS = ['elements', 'viewport'] as const;
export const ROOM_SETTINGS_KEYS = [
  'maxUsers',
  'name',
  'hostPeerId',
  'allowFirstUserHost',
  'guestAccess',
  'rotateGuestPin',
] as const;

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

function addBoundedSceneValueIssues(
  value: unknown,
  depth: number,
  ctx: z.RefinementCtx,
): void {
  if (depth > MAX_ELEMENT_NEST_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      message: 'element nesting exceeds maximum depth',
    });
    return;
  }

  if (value === null || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'element number must be finite',
      });
    }
    return;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_ELEMENT_STRING_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: 'element string exceeds maximum length',
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addBoundedSceneValueIssues(item, depth + 1, ctx);
    }
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > MAX_ELEMENT_KEYS) {
      ctx.addIssue({
        code: 'custom',
        message: 'element object exceeds maximum key count',
      });
      return;
    }
    for (const key of keys) {
      if (key.length > MAX_ELEMENT_STRING_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          message: 'element key exceeds maximum length',
        });
        return;
      }
      addBoundedSceneValueIssues(record[key], depth + 1, ctx);
    }
    return;
  }

  ctx.addIssue({
    code: 'custom',
    message: 'element contains unsupported value type',
  });
}

function isAllowedElementLink(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith('//')) {
    return false;
  }
  if (
    trimmed.startsWith('/')
    || trimmed.startsWith('./')
    || trimmed.startsWith('../')
    || trimmed.startsWith('#')
    || trimmed.startsWith('?')
  ) {
    return true;
  }
  try {
    return new URL(trimmed).protocol === 'https:';
  } catch {
    return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  }
}

export const sceneElementSchema = z
  .object({
    id: z.string().regex(ELEMENT_ID_RE, 'element id must match the allowed grammar'),
    type: z.string().max(MAX_ELEMENT_TYPE_LENGTH).optional(),
  })
  .passthrough()
  .superRefine((element, ctx) => {
    if (typeof element.type === 'string') {
      const normalizedType = element.type.trim().toLowerCase();
      if (BLOCKED_ELEMENT_TYPES.has(normalizedType)) {
        ctx.addIssue({
          code: 'custom',
          message: 'element type is not permitted',
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(element, 'link')) {
      const link = (element as { link?: unknown }).link;
      if (link != null) {
        if (typeof link !== 'string' || !isAllowedElementLink(link)) {
          ctx.addIssue({
            code: 'custom',
            message: 'element link must be https or a relative URL',
          });
        }
      }
    }

    const keys = Object.keys(element);
    if (keys.length > MAX_ELEMENT_KEYS) {
      ctx.addIssue({
        code: 'custom',
        message: 'element object exceeds maximum key count',
      });
      return;
    }

    for (const [key, value] of Object.entries(element)) {
      if (key === 'id' || key === 'type') {
        continue;
      }
      addBoundedSceneValueIssues(value, 1, ctx);
    }
  });

export const roomSceneSchema = z.object({
  elements: z.array(sceneElementSchema).max(MAX_ELEMENTS).optional(),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite(),
  }).optional(),
});

export const roomSettingsSchema = z.object({
  maxUsers: z.number().int().min(1).max(MAX_MAX_USERS).optional(),
  hostPeerId: z.string().regex(PEER_ID_RE).optional(),
  name: normalizedNameBase.optional(),
  allowFirstUserHost: z.boolean().optional(),
  guestAccess: z.boolean().optional(),
  rotateGuestPin: z.boolean().optional(),
  // PIN is server-issued only. A client-supplied value is rejected, never stored.
  guestPin: z.undefined().optional(),
  pin: z.undefined().optional(),
});

export const roomPostSchema = roomSceneSchema;

export const presencePostSchema = z.object({
  action: z.enum(['kick', 'suspend', 'raise-hand', 'lower-hand']).optional(),
  peerId: z.string().regex(PEER_ID_RE).optional(),
  accountId: z.string().regex(ACCOUNT_ID_RE).optional(),
  userName: normalizedNameBase.optional(),
  color: z.string().regex(COLOR_RE).optional(),
}).superRefine((data, ctx) => {
  const hasTarget = Boolean(data.peerId || data.accountId);
  if (data.action === 'kick' || data.action === 'suspend') {
    if (!hasTarget) {
      ctx.addIssue({ code: 'custom', message: 'accountId or peerId is required' });
    }
    return;
  }
  if (data.action === 'raise-hand' || data.action === 'lower-hand') {
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
  userName: normalizedNameBase,
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

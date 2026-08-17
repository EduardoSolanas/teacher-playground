import { z } from 'zod';

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown
): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const firstIssue = result.error.issues[0];
  const message = firstIssue?.message || 'Invalid request body';
  return { ok: false, error: message };
}

export const roomPostSchema = z.object({
  elements: z.unknown().optional(),
  viewport: z.unknown().optional(),
  maxUsers: z.unknown().optional(),
  hostPeerId: z.string().optional(),
  name: z.string().optional(),
});

export const presencePostSchema = z.object({
  action: z.enum(['kick', 'suspend']).optional(),
  peerId: z.string().optional(),
  userName: z.string().optional(),
  color: z.string().optional(),
});

export const waitingPostSchema = z.object({
  peerId: z.string().min(1, 'peerId is required'),
  action: z.enum(['approve', 'reject']),
});

export const requestsPostSchema = z.object({
  userName: z.string().min(1, 'userName is required'),
  email: z.string().optional(),
});

export const requestActionPostSchema = z.object({
  action: z.enum(['approve', 'deny']),
  role: z.enum(['peer', 'viewer']).optional(),
});

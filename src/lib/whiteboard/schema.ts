import { z } from 'zod';

export const CanvasElementSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('pen'),
    points: z.array(z.object({ x: z.number(), y: z.number() })),
    color: z.string(),
    strokeWidth: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('text'),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    text: z.string().max(10000),
    color: z.string(),
    fontSize: z.number(),
    fontFamily: z.string(),
    bold: z.boolean(),
    italic: z.boolean(),
    rotation: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('rectangle'),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    fill: z.string(),
    stroke: z.string(),
    strokeWidth: z.number(),
    rotation: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('circle'),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    fill: z.string(),
    stroke: z.string(),
    strokeWidth: z.number(),
    rotation: z.number().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('line'),
    points: z.array(z.object({ x: z.number(), y: z.number() })),
    stroke: z.string(),
    strokeWidth: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('arrow'),
    points: z.array(z.object({ x: z.number(), y: z.number() })),
    stroke: z.string(),
    strokeWidth: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('stickyNote'),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    content: z.string().max(5000),
    backgroundColor: z.string(),
    borderColor: z.string(),
    borderRadius: z.number(),
    rotation: z.number().optional(),
  }),
]);

export function validateElement(data: unknown) {
  try {
    return CanvasElementSchema.parse(data);
  } catch {
    return null;
  }
}

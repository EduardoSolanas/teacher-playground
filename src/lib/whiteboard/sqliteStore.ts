import type { CanvasElement, Viewport } from '@/types/whiteboard';

// In-memory store for client-side use
// Server-side persistence is handled via API routes

const rooms = new Map<string, {
  elements: CanvasElement[];
  viewport: Viewport;
  updatedAt: number;
}>();

export function createRoom(
  roomId: string,
  elements: CanvasElement[] = [],
  viewport: Viewport = { x: 0, y: 0, zoom: 1 }
): void {
  rooms.set(roomId, { elements, viewport, updatedAt: Date.now() });
}

export function getRoom(roomId: string): {
  elements: CanvasElement[];
  viewport: Viewport;
  updatedAt: number;
} | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  return { ...room };
}

export function updateRoom(
  roomId: string,
  elements: CanvasElement[],
  viewport: Viewport
): void {
  const existing = rooms.get(roomId);
  if (!existing) {
    rooms.set(roomId, { elements, viewport, updatedAt: Date.now() });
    return;
  }
  rooms.set(roomId, { elements, viewport, updatedAt: Date.now() });
}

export function deleteRoom(roomId: string): void {
  rooms.delete(roomId);
}

export function getAllRooms(): { room_id: string; updated_at: number }[] {
  const result: { room_id: string; updated_at: number }[] = [];
  rooms.forEach((value, key) => {
    result.push({ room_id: key, updated_at: value.updatedAt });
  });
  result.sort((a, b) => b.updated_at - a.updated_at);
  return result;
}

export function cleanupStaleRooms(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;
  for (const [key, value] of rooms) {
    if (value.updatedAt < cutoff) {
      rooms.delete(key);
      deleted++;
    }
  }
  return deleted;
}

import { useCallback, useEffect, useState } from 'react';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/**
 * The boards of a room: what the tabs show and how they change.
 *
 * The list lives in the shared document's `boardsMeta` map, so every peer sees
 * the same tabs without a route of its own. The map is guarded server-side
 * (capped, shape-checked), and writes go through the document like drawing
 * does — an admitted editor can add a board exactly as they can draw on one.
 */
export type RoomBoard = {
  id: string;
  name: string;
  order: number;
};

const MAIN_BOARD_ID = 'main';
const MAX_BOARDS = 50;

export function mainBoard(): RoomBoard {
  return { id: MAIN_BOARD_ID, name: 'Board 1', order: 0 };
}

function readBoards(doc: {
  getMap: (name: string) => {
    size: number;
    keys: () => Iterable<string>;
    get: (key: string) => unknown;
  };
}): RoomBoard[] {
  const meta = doc.getMap('boardsMeta');
  const boards: RoomBoard[] = [];
  for (const id of meta.keys()) {
    const value = meta.get(id);
    if (value === null || typeof value !== 'object') continue;
    const record = value as { name?: unknown; order?: unknown };
    // Main owns "Board 1", so the fallback counts past it rather than
    // duplicating it.
    const name = typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name
      : `Board ${boards.length + 2}`;
    const order = typeof record.order === 'number' && Number.isFinite(record.order)
      ? record.order
      : boards.length;
    boards.push({ id, name, order });
  }
  boards.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // The main board is always first and always present: it is where existing
  // rooms' unstamped elements live.
  const withoutMain = boards.filter((board) => board.id !== MAIN_BOARD_ID);
  return [mainBoard(), ...withoutMain];
}

/**
 * The room's boards, live from the shared document, with the writes the tab
 * strip needs.
 */
export function useBoardList(
  yDoc: { getMap: (name: string) => {
    size: number;
    keys: () => Iterable<string>;
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
    observe: (fn: () => void) => void;
    unobserve: (fn: () => void) => void;
  }; transact: (fn: () => void, origin?: string) => void } | null,
): {
  boards: RoomBoard[];
  addBoard: () => string;
  renameBoard: (id: string, name: string) => void;
} {
  const [boards, setBoards] = useState<RoomBoard[]>([mainBoard()]);

  useEffect(() => {
    if (!yDoc) return;
    const meta = yDoc.getMap('boardsMeta');
    const refresh = () => setBoards(readBoards(yDoc));
    refresh();
    meta.observe(refresh);
    return () => meta.unobserve(refresh);
  }, [yDoc]);

  const addBoard = useCallback((): string => {
    if (!yDoc) return MAIN_BOARD_ID;
    const existing = readBoards(yDoc);
    if (existing.length >= MAX_BOARDS) return MAIN_BOARD_ID;

    const id = `board-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const name = `Board ${existing.length + 1}`;
    const order = (existing[existing.length - 1]?.order ?? 0) + 1;
    yDoc.transact(() => {
      yDoc.getMap('boardsMeta').set(id, { name, order, createdAt: Date.now() });
    }, 'local');
    return id;
  }, [yDoc]);

  const renameBoard = useCallback((id: string, name: string) => {
    if (!yDoc || id === MAIN_BOARD_ID) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const current = yDoc.getMap('boardsMeta').get(id);
    const record = (current !== null && typeof current === 'object' ? current : {}) as Record<string, unknown>;
    yDoc.transact(() => {
      yDoc.getMap('boardsMeta').set(id, { ...record, name: trimmed });
    }, 'local');
  }, [yDoc]);

  return { boards, addBoard, renameBoard };
}

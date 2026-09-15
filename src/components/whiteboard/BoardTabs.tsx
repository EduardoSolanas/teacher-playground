'use client';

import { useCallback, useState } from 'react';

import { useBoardList } from '@/lib/whiteboard/boards';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

/*
 * Outcome messages read like the seats panel's: one short amber sentence in
 * a small dark panel, with a Retry where trying again is the whole fix.
 */
const OUTCOME_PANEL_CLASS =
  'absolute left-2 top-full z-[1300] mt-1 w-64 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 shadow-xl shadow-slate-950/40';
const OUTCOME_TEXT_CLASS = 'm-0 text-[0.75rem] leading-relaxed text-amber-300';

/**
 * The room's boards as a strip of tabs over the canvas.
 *
 * The list is the shared document's own -- read through {@link useBoardList},
 * so a board a peer added appears here without a reload -- and the active
 * board stays state of the room, not of this strip: the editor above takes it
 * as a prop, so a switch is one value changing hands.
 *
 * Clearing a board asks the owner-only clear route which board to empty; it
 * never empties anything itself. The add control is for every admitted editor,
 * exactly like drawing is -- a refusal from the hook (no document, or the
 * room's cap) keeps the board where it is and says so rather than jumping.
 */
export default function BoardTabs({
  roomId,
  yDoc,
  activeBoardId,
  onSelectBoard,
  canClearBoard,
  request = ajaxFetch,
}: {
  readonly roomId: string;
  readonly yDoc: Parameters<typeof useBoardList>[0];
  readonly activeBoardId: string;
  readonly onSelectBoard: (id: string) => void;
  /** The viewer is the room's owner; the clear control is theirs alone. */
  readonly canClearBoard: boolean;
  /** Injected so tests can drive the clear route with real responses. */
  readonly request?: AjaxFetch;
}) {
  const { boards, addBoard } = useBoardList(yDoc);
  const [addRefused, setAddRefused] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearOutcome, setClearOutcome] = useState<'done' | 'error' | null>(null);

  const handleAdd = useCallback(() => {
    setClearOutcome(null);
    const created = addBoard();
    /*
     * 'main' is both the room's first board and the hook's fallback when
     * nothing can be added -- no document, or the room's cap -- so a fallback
     * must not be read as "switch to the main board", which would yank the
     * lesson out from under a full room. Any other id is a board that was
     * just created, and the editor moves to it.
     */
    if (created === 'main') {
      setAddRefused(true);
      return;
    }
    setAddRefused(false);
    onSelectBoard(created);
  }, [addBoard, onSelectBoard]);

  const clearActiveBoard = useCallback(async () => {
    setClearing(true);
    setClearOutcome(null);
    try {
      const response = await request(`/api/whiteboard/room/${roomId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: activeBoardId }),
      });
      setClearOutcome(response.ok ? 'done' : 'error');
    } catch {
      setClearOutcome('error');
    } finally {
      setClearing(false);
    }
  }, [activeBoardId, request, roomId]);

  return (
    <div
      data-testid="board-tabs"
      className="relative flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-1"
    >
      {boards.map((board) => (
        <button
          key={board.id}
          type="button"
          data-testid={`board-tab-${board.id}`}
          aria-pressed={board.id === activeBoardId}
          onClick={() => onSelectBoard(board.id)}
          className={`rounded-md px-2 py-0.5 text-[0.75rem] font-medium transition-colors ${
            board.id === activeBoardId
              ? 'bg-slate-800 text-slate-100'
              : 'text-slate-600 hover:bg-slate-800/10'
          }`}
        >
          {board.name}
        </button>
      ))}
      <button
        type="button"
        data-testid="board-tabs-add"
        aria-label="Add board"
        title="Add board"
        onClick={handleAdd}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-800/10 hover:text-slate-700"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
      {canClearBoard && (
        <button
          type="button"
          data-testid="board-tabs-clear"
          aria-label="Clear this board"
          title="Clear this board"
          disabled={clearing}
          onClick={() => { void clearActiveBoard(); }}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </button>
      )}
      {(addRefused || clearOutcome !== null) && (
        <div className={OUTCOME_PANEL_CLASS}>
          {addRefused && (
            <p role="status" data-testid="board-tabs-add-refused" className={OUTCOME_TEXT_CLASS}>
              A new board couldn&rsquo;t be added. This room may already hold the most it can.
            </p>
          )}
          {clearOutcome === 'done' && (
            <p role="status" data-testid="board-tabs-clear-done" className={OUTCOME_TEXT_CLASS}>
              Board cleared.
            </p>
          )}
          {clearOutcome === 'error' && (
            <p role="status" data-testid="board-tabs-clear-error" className={OUTCOME_TEXT_CLASS}>
              Couldn&rsquo;t clear this board.{' '}
              <button
                type="button"
                data-testid="board-tabs-clear-retry"
                onClick={() => { void clearActiveBoard(); }}
                className="underline"
              >
                Retry
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';

import { useBoardList } from '@/lib/whiteboard/boards';
import ConfirmDialog from '@/components/ConfirmDialog';
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
 *
 * A board's name is edited in place: double-clicking its tab swaps the button
 * for an input that commits through the hook, so the label is always the
 * shared document's own and a peer's rename shows up here too. 'main' is not
 * a stored definition, so it is not offered a rename at all.
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
  const { boards, addBoard, renameBoard } = useBoardList(yDoc);
  const [addRefused, setAddRefused] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearOutcome, setClearOutcome] = useState<'done' | 'error' | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteOutcome, setDeleteOutcome] = useState<'done' | 'error' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const startRename = useCallback((id: string, name: string) => {
    // 'main' is the room's first board, not a stored definition: the hook
    // would refuse the write, so the strip must not pretend it can.
    if (id === 'main') return;
    setRenameDraft(name);
    setRenamingId(id);
  }, []);

  const commitRename = useCallback(() => {
    /*
     * The null guard also keeps a blur fired while Escape's unmount tears the
     * input down from writing a rename that was just cancelled. A blank draft
     * reaches the hook, which refuses it silently: the editor closes with the
     * name unchanged and nothing pretends to have saved.
     */
    if (!renamingId) return;
    renameBoard(renamingId, renameDraft);
    setRenamingId(null);
  }, [renameBoard, renameDraft, renamingId]);

  /*
   * A board can vanish under a peer: the owner's delete arrives as a
   * document update, not a click, so this client's active board can end up
   * pointing at a tab that no longer exists. When the live list no longer
   * holds the active board, the room lands back on the main board -- the
   * room's floor, which is never deletable.
   */
  useEffect(() => {
    if (activeBoardId !== 'main' && !boards.some((board) => board.id === activeBoardId)) {
      onSelectBoard('main');
    }
  }, [activeBoardId, boards, onSelectBoard]);

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

  const deleteActiveBoard = useCallback(async () => {
    setDeleting(true);
    setDeleteOutcome(null);
    try {
      const response = await request(`/api/whiteboard/room/${roomId}/boards/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId: activeBoardId }),
      });
      if (response.ok) {
        setDeleteOutcome('done');
        onSelectBoard('main');
      } else {
        setDeleteOutcome('error');
      }
    } catch {
      setDeleteOutcome('error');
    } finally {
      setDeleting(false);
    }
  }, [activeBoardId, onSelectBoard, request, roomId]);

  return (
    <div
      data-testid="board-tabs"
      className="relative flex shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-1"
    >
      {boards.map((board) =>
        board.id === renamingId ? (
          <input
            key={board.id}
            data-testid="board-name-input"
            aria-label="Board name"
            autoFocus
            value={renameDraft}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') setRenamingId(null);
            }}
            onBlur={commitRename}
            className="w-24 rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-[0.75rem] font-medium text-slate-100"
          />
        ) : (
          <button
            key={board.id}
            type="button"
            data-testid={`board-tab-${board.id}`}
            aria-pressed={board.id === activeBoardId}
            onClick={() => onSelectBoard(board.id)}
            onDoubleClick={() => startRename(board.id, board.name)}
            className={`rounded-md px-2 py-0.5 text-[0.75rem] font-medium transition-colors ${
              board.id === activeBoardId
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-600 hover:bg-slate-800/10'
            }`}
          >
            {board.name}
          </button>
        ),
      )}
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
          disabled={clearing || deleting}
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
      {canClearBoard && activeBoardId !== 'main' && (
        <button
          type="button"
          data-testid="board-tabs-delete"
          aria-label="Delete this board"
          title="Delete this board"
          disabled={clearing || deleting}
          onClick={() => { setConfirmingDelete(true); }}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 7h16" />
            <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            <path d="M6 7l1 12h10l1-12" />
            <path d="M9 11l6 6" />
            <path d="M15 11l-6 6" />
          </svg>
        </button>
      )}
      {(addRefused || clearOutcome !== null || deleteOutcome !== null) && (
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
          {deleteOutcome === 'done' && (
            <p role="status" data-testid="board-tabs-delete-done" className={OUTCOME_TEXT_CLASS}>
              Board deleted.
            </p>
          )}
          {deleteOutcome === 'error' && (
            <p role="status" data-testid="board-tabs-delete-error" className={OUTCOME_TEXT_CLASS}>
              Couldn&rsquo;t delete this board.{' '}
              <button
                type="button"
                data-testid="board-tabs-delete-retry"
                onClick={() => { void deleteActiveBoard(); }}
                className="underline"
              >
                Retry
              </button>
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmingDelete}
        title="Delete Board"
        body="This will remove the board and everything on it for all users. Are you sure?"
        confirmLabel="Delete Board"
        testIdPrefix="board-delete"
        onConfirm={() => {
          setConfirmingDelete(false);
          void deleteActiveBoard();
        }}
        onCancel={() => { setConfirmingDelete(false); }}
      />
    </div>
  );
}

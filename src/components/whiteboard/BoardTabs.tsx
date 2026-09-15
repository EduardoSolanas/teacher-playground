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
 * Clearing and deleting a board ask the owner-only routes; both confirm
 * first, and both dialogs name the board they are about to erase. The add
 * control is for every admitted editor, exactly like drawing is -- a refusal
 * from the hook (the room's cap, or no document yet) keeps the board where it
 * is and says which one it was.
 *
 * A board's name is edited in place: double-clicking -- or focusing and
 * pressing F2 -- swaps the tab for an input that commits through the hook, so
 * the label is always the shared document's own and a peer's rename shows up
 * here too. 'main' is not a stored definition, so it is not offered a rename
 * at all.
 *
 * The tabs scroll inside their own run; the controls a teacher mid-lesson
 * cannot afford to lose -- add, clear, delete -- sit pinned outside it.
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
  const [addRefused, setAddRefused] = useState<'cap' | 'offline' | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearOutcome, setClearOutcome] = useState<'done' | 'error' | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteOutcome, setDeleteOutcome] = useState<'done' | 'error' | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Outcomes name the board they acted on, so a strip full of tabs still
  // says what just happened to which one.
  const activeName = boards.find((board) => board.id === activeBoardId)?.name ?? 'Board';

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

  /*
   * A success speaks once and then gets out of the canvas's way; a failure
   * stays until the teacher deals with it. The panel sits over the top-left
   * of the drawing area, which is room a lesson wants back.
   */
  useEffect(() => {
    if (clearOutcome !== 'done' && deleteOutcome !== 'done') return;
    const timer = window.setTimeout(() => {
      setClearOutcome((outcome) => (outcome === 'done' ? null : outcome));
      setDeleteOutcome((outcome) => (outcome === 'done' ? null : outcome));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [clearOutcome, deleteOutcome]);

  const handleAdd = useCallback(() => {
    setClearOutcome(null);
    setDeleteOutcome(null);
    if (!yDoc) {
      /*
       * No document yet means the socket has not delivered the room: adding
       * is not refused by the room, it is just not possible yet.
       */
      setAddRefused('offline');
      return;
    }
    const created = addBoard();
    /*
     * 'main' is both the room's first board and the hook's fallback when
     * nothing can be added -- the room's cap -- so a fallback must not be
     * read as "switch to the main board", which would yank the lesson out
     * from under a full room. Any other id is a board that was just created,
     * and the editor moves to it.
     */
    if (created === 'main') {
      setAddRefused('cap');
      return;
    }
    setAddRefused(null);
    onSelectBoard(created);
  }, [addBoard, onSelectBoard, yDoc]);

  const clearActiveBoard = useCallback(async () => {
    setClearing(true);
    setClearOutcome(null);
    setDeleteOutcome(null);
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
    setClearOutcome(null);
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
      className="relative flex min-w-0 shrink-0 items-center gap-1 border-b border-slate-200 px-2 py-1"
    >
      <div
        data-testid="board-tabs-run"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
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
              className="w-40 shrink-0 rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-[0.75rem] font-medium text-slate-100"
            />
          ) : (
            <div
              key={board.id}
              className={`flex min-w-0 max-w-[10rem] shrink-0 items-center rounded-md transition-colors ${
                board.id === activeBoardId
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-600 hover:bg-slate-800/10'
              }`}
            >
              <button
                type="button"
                data-testid={`board-tab-${board.id}`}
                aria-pressed={board.id === activeBoardId}
                title={
                  board.id === 'main'
                    ? `${board.name} — the room's first board`
                    : `${board.name} — double-click, press F2, or use the pencil to rename`
                }
                onClick={() => onSelectBoard(board.id)}
                onDoubleClick={() => startRename(board.id, board.name)}
                onKeyDown={(event) => {
                  if (event.key === 'F2') startRename(board.id, board.name);
                }}
                className="flex min-w-0 items-center rounded-md px-2 py-0.5 text-[0.75rem] font-medium"
              >
                <span className="truncate">{board.name}</span>
              </button>
              {board.id !== 'main' && (
                <button
                  type="button"
                  data-testid={`board-pencil-${board.id}`}
                  aria-label={`Rename ${board.name}`}
                  title={`Rename ${board.name}`}
                  onClick={() => startRename(board.id, board.name)}
                  className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-slate-100"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              )}
            </div>
          ),
        )}
      </div>
      <button
        type="button"
        data-testid="board-tabs-add"
        aria-label="Add board"
        title="Add board"
        onClick={handleAdd}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-800/10 hover:text-slate-700"
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
          onClick={() => { setConfirmingClear(true); }}
          className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
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
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
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
      {(addRefused !== null || clearOutcome !== null || deleteOutcome !== null) && (
        <div className={OUTCOME_PANEL_CLASS}>
          {addRefused === 'cap' && (
            <p role="status" data-testid="board-tabs-add-refused" className={OUTCOME_TEXT_CLASS}>
              This room already holds the most boards it can (50). Delete a board to make room.
            </p>
          )}
          {addRefused === 'offline' && (
            <p role="status" data-testid="board-tabs-add-offline" className={OUTCOME_TEXT_CLASS}>
              Reconnect to the room before adding boards.
            </p>
          )}
          {clearOutcome === 'done' && (
            <p role="status" data-testid="board-tabs-clear-done" className={OUTCOME_TEXT_CLASS}>
              {`${activeName} cleared.`}
            </p>
          )}
          {clearOutcome === 'error' && (
            <p role="status" data-testid="board-tabs-clear-error" className={OUTCOME_TEXT_CLASS}>
              {`Couldn't clear '${activeName}'. `}
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
              {`${activeName} deleted.`}
            </p>
          )}
          {deleteOutcome === 'error' && (
            <p role="status" data-testid="board-tabs-delete-error" className={OUTCOME_TEXT_CLASS}>
              {`Couldn't delete '${activeName}'. `}
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
        isOpen={confirmingClear}
        title="Clear this board"
        body={`This will erase everything on '${activeName}' for all users. Are you sure?`}
        confirmLabel="Clear board"
        testIdPrefix="board-clear"
        onConfirm={() => {
          setConfirmingClear(false);
          void clearActiveBoard();
        }}
        onCancel={() => { setConfirmingClear(false); }}
      />
      <ConfirmDialog
        isOpen={confirmingDelete}
        title="Delete board"
        body={`This will remove '${activeName}' and everything on it for all users. Are you sure?`}
        confirmLabel="Delete board"
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

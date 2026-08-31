'use client';

import { useEffect, useState } from 'react';

import { teacherRoomTitle } from './TeacherRoomList';

/**
 * What the room is called, in the middle of the top bar.
 *
 * A room code is thirty-two hexadecimal characters and identifies nothing at a
 * glance, so the bar carries the name instead -- and the name is the one thing
 * a teacher is most likely to want to fix while looking straight at it, half
 * way through setting a lesson up. The pencil is there rather than in a
 * settings page for that reason.
 *
 * Renaming is owner-only on the server, so the pencil is owner-only here. A
 * pencil for anybody else is a button whose only outcome is a 403.
 */
export default function RoomNameField({
  name,
  canRename,
  onRename,
}: {
  readonly name: string | null;
  readonly canRename: boolean;
  readonly onRename: (next: string) => void;
}) {
  const title = teacherRoomTitle({ roomId: '', name });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  /*
   * Follow a rename that came from somewhere else -- the room list, another
   * tab -- but never while this box is open, or a poll landing mid-edit would
   * take the words out from under the person typing them.
   */
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commit = () => {
    const next = draft.trim();
    /*
     * roomSettingsSchema takes a non-empty string or nothing at all, so a
     * blank save would 400 and be swallowed by the caller: an edit that looks
     * committed and changed nothing. Keep the box open instead.
     */
    if (!next) return;
    onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        data-testid="room-name-input"
        autoFocus
        value={draft}
        aria-label="Room name"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setDraft(title);
            setEditing(false);
          }
        }}
        onBlur={commit}
        className="w-full max-w-[16rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-center text-[0.8125rem] font-medium text-slate-100 outline-none focus:border-slate-400"
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        data-testid="room-name"
        title={title}
        className="truncate text-[0.8125rem] font-medium text-slate-200"
      >
        {title}
      </span>
      {canRename && (
        <button
          type="button"
          data-testid="room-name-edit"
          aria-label="Rename room"
          title="Rename room"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
      )}
    </div>
  );
}

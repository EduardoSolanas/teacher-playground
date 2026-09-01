'use client';

import { useEffect, useRef, useState } from 'react';

import { teacherRoomTitle } from './TeacherRoomList';

/**
 * What the room is called, and the way into what can be done with it.
 *
 * The name was a label with a pencil beside it, which said "this one field can
 * be edited" and nothing about the rest. A room has more to it than its name --
 * taking a copy away, reaching the library -- and those were scattered: one in
 * a hamburger in the far corner of the canvas, one floating over the board.
 * They belong together, and the title is where somebody looks to find out what
 * room they are in.
 *
 * Everything behind it is the owner's, so somebody who may not manage the room
 * sees the name and no menu at all rather than a menu that refuses them.
 */
export default function RoomTitleMenu({
  name,
  canManage,
  onRename,
  onSaveAs,
  onOpenLibrary,
}: {
  readonly name: string | null;
  readonly canManage: boolean;
  readonly onRename: (next: string) => void;
  readonly onSaveAs: () => void;
  readonly onOpenLibrary: () => void;
}) {
  const title = teacherRoomTitle({ roomId: '', name });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const rootRef = useRef<HTMLDivElement>(null);

  /*
   * Follow a rename from anywhere else -- the room list, another tab -- but
   * never while the box is open, or a poll landing mid-edit would take the
   * words out from under the person typing them.
   */
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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

  const label = (
    <span data-testid="room-name" title={title} className="truncate">
      {title}
    </span>
  );

  if (!canManage) {
    return (
      <span className="min-w-0 truncate text-[0.8125rem] font-medium text-slate-200">{label}</span>
    );
  }

  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[0.8125rem] text-slate-200 transition-colors hover:bg-slate-700';

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        data-testid="room-title-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[0.8125rem] font-medium text-slate-200 transition-colors hover:bg-slate-700"
      >
        {label}
        {/* Without this the title is a word, and a word is not a control. */}
        <svg
          data-testid="room-title-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="room-title-menu"
          className="absolute left-1/2 top-full z-[1200] mt-1 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl shadow-slate-950/40"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="room-menu-save"
            className={item}
            onClick={() => {
              setOpen(false);
              onSaveAs();
            }}
          >
            Save as…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="room-menu-rename"
            className={item}
            onClick={() => {
              setOpen(false);
              setDraft(title);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="room-menu-library"
            className={item}
            onClick={() => {
              setOpen(false);
              onOpenLibrary();
            }}
          >
            Add to library
          </button>
        </div>
      )}
    </div>
  );
}

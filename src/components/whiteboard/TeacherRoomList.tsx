'use client';

import { useEffect, useState } from 'react';

export type TeacherRoomSummary = {
  roomId: string;
  name?: string | null;
  createdAt?: number;
};

export function teacherRoomTitle(room: TeacherRoomSummary): string {
  const trimmed = room.name?.trim();
  if (trimmed) return trimmed;
  if (typeof room.createdAt === 'number') {
    return new Date(room.createdAt).toISOString().replace('T', ' ').slice(0, 16);
  }
  return room.roomId;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const ICON_BUTTON =
  'grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-700';

export default function TeacherRoomList({
  rooms,
  loading = false,
  onOpen,
  onRename,
  onDelete,
}: {
  rooms: TeacherRoomSummary[];
  loading?: boolean;
  onOpen: (roomId: string) => void;
  onRename?: (roomId: string, nextName: string) => void;
  onDelete?: (roomId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!menuOpenId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // Clicks inside the open menu must not close it before they land.
      if (target instanceof Element && target.closest('[data-room-menu]')) return;
      setMenuOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpenId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpenId]);

  const copyShareLink = async (roomId: string) => {
    const url = `${window.location.origin}/whiteboard/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyError(false);
      setCopiedId(roomId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopyError(true);
      setCopiedId(null);
    }
  };

  return (
    <section className="w-full text-left">
      <h2 className="text-base font-bold text-slate-900 sm:text-lg">Your rooms</h2>

      {loading ? (
        <p
          data-testid="whiteboard-room-list-loading"
          className="mt-3 text-sm text-slate-500"
        >
          Loading rooms…
        </p>
      ) : rooms.length === 0 ? (
        <p
          data-testid="whiteboard-room-list-empty"
          className="mt-3 rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-400"
        >
          No rooms yet. Create one below.
        </p>
      ) : (
        <ul data-testid="whiteboard-room-list" className="mt-3 flex list-none flex-col gap-2 p-0">
          {rooms.map((room) => {
            const label = teacherRoomTitle(room);
            const editing = editingId === room.roomId;
            const menuOpen = menuOpenId === room.roomId;
            const copied = copiedId === room.roomId;
            const confirmingDelete = confirmDeleteId === room.roomId;

            return (
              <li
                key={room.roomId}
                className="relative rounded-2xl bg-slate-50 p-2 ring-1 ring-slate-200/70 transition-colors hover:bg-slate-100/80"
              >
                {editing ? (
                  <div className="flex flex-col gap-2 p-1 sm:flex-row sm:items-center">
                    <input
                      data-testid={`whiteboard-room-name-input-${room.roomId}`}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          onRename?.(room.roomId, draftName);
                          setEditingId(null);
                        }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                      className="h-11 w-full min-w-0 rounded-xl border-2 border-indigo-500 bg-white px-3 text-base text-slate-900 outline-none sm:flex-1"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid={`whiteboard-room-name-save-${room.roomId}`}
                        onClick={() => {
                          onRename?.(room.roomId, draftName);
                          setEditingId(null);
                        }}
                        className="h-11 flex-1 rounded-xl bg-indigo-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-indigo-600 sm:flex-none"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="h-11 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : confirmingDelete ? (
                  <div className="flex flex-col gap-2 p-1 sm:flex-row sm:items-center">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                      Delete “{label}”?
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid={`whiteboard-room-delete-confirm-${room.roomId}`}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onDelete?.(room.roomId);
                        }}
                        className="h-11 flex-1 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-700 sm:flex-none"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="h-11 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <a
                      href={`/whiteboard/${room.roomId}`}
                      data-testid={`whiteboard-room-list-item-${room.roomId}`}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpen(room.roomId);
                      }}
                      className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-xl px-2.5 py-2 no-underline"
                    >
                      <span className="truncate text-[15px] font-semibold text-slate-900">
                        {label}
                      </span>
                      {room.createdAt && (
                        <span className="truncate text-xs font-normal text-slate-400">
                          {formatDate(room.createdAt)}
                        </span>
                      )}
                    </a>

                    <button
                      type="button"
                      data-testid={`whiteboard-room-share-${room.roomId}`}
                      onClick={() => copyShareLink(room.roomId)}
                      title="Copy share link"
                      aria-label={copied ? 'Share link copied' : 'Copy share link'}
                      className={
                        copied
                          ? 'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-green-200 bg-green-50 px-3 text-[13px] font-semibold text-green-700 transition-colors'
                          : 'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100'
                      }
                    >
                      {copied ? (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                        >
                          <path d="m20 6-11 11-5-5" />
                        </svg>
                      ) : (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                        >
                          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                        </svg>
                      )}
                      <span className="hidden sm:inline">{copied ? 'Copied!' : 'Share link'}</span>
                    </button>

                    <div className="relative shrink-0" data-room-menu>
                      <button
                        type="button"
                        data-testid={`whiteboard-room-menu-${room.roomId}`}
                        aria-label={`More actions for ${label}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpenId(menuOpen ? null : room.roomId)}
                        className={ICON_BUTTON}
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          className="h-5 w-5"
                        >
                          <circle cx="5" cy="12" r="1.75" />
                          <circle cx="12" cy="12" r="1.75" />
                          <circle cx="19" cy="12" r="1.75" />
                        </svg>
                      </button>

                      {menuOpen && (
                        <div
                          role="menu"
                          className="absolute right-0 top-full z-10 mt-1.5 min-w-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-900/10"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            data-testid={`whiteboard-room-rename-${room.roomId}`}
                            onClick={() => {
                              setEditingId(room.roomId);
                              setDraftName(room.name?.trim() ?? '');
                              setMenuOpenId(null);
                            }}
                            className="block h-11 w-full border-none bg-transparent px-4 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100"
                          >
                            Rename
                          </button>
                          {onDelete && (
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`whiteboard-room-delete-${room.roomId}`}
                              onClick={() => {
                                setMenuOpenId(null);
                                setConfirmDeleteId(room.roomId);
                              }}
                              className="block h-11 w-full border-none bg-transparent px-4 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {copyError && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-600">
          Could not copy the link. Long-press the room name to copy it manually.
        </p>
      )}
    </section>
  );
}

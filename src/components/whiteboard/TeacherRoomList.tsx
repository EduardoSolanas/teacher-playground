'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { guestHostJoinUrl } from '@/lib/whiteboard/guestJoinUrl';
import CopyButton from './CopyButton';
import GuestAccessSettings from './GuestAccessSettings';

export type TeacherRoomSummary = {
  roomId: string;
  name?: string | null;
  createdAt?: number;
};

/** Shown for a room nobody has named yet. */
export const UNNAMED_ROOM_TITLE = 'Untitled room';

/**
 * What a room is called in the list.
 *
 * This used to fall back to the room code, because the code was the only thing
 * identifying an unnamed room and it appeared nowhere else in the row. That
 * made the heading a thirty-two character hexadecimal string: unreadable at a
 * glance, impossible to read down a phone, and the same shape as every other
 * unnamed room, so a list of them identified nothing.
 *
 * The row now prints the code on its own labelled line, which is what the
 * fallback was really for, so the heading is free to say what it means.
 */
export function teacherRoomTitle(room: TeacherRoomSummary): string {
  const trimmed = room.name?.trim();
  if (trimmed) return trimmed;
  return UNNAMED_ROOM_TITLE;
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

function parseGuestSettings(payload: unknown): {
  guestAccess: boolean;
  guestPin: string | null;
  guestPinExpiresAt: number | null;
  lockoutUntil: number | null;
} {
  if (!payload || typeof payload !== 'object') {
    return { guestAccess: false, guestPin: null, guestPinExpiresAt: null, lockoutUntil: null };
  }
  const record = payload as Record<string, unknown>;
  return {
    guestAccess: record.guestAccess === true,
    guestPin: typeof record.guestPin === 'string' ? record.guestPin : null,
    guestPinExpiresAt: typeof record.guestPinExpiresAt === 'number' ? record.guestPinExpiresAt : null,
    lockoutUntil: typeof record.lockoutUntil === 'number' ? record.lockoutUntil : null,
  };
}

const ICON_BUTTON = 'icon-btn';

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
  const [guestPanelId, setGuestPanelId] = useState<string | null>(null);
  const [guestSettings, setGuestSettings] = useState<ReturnType<typeof parseGuestSettings> | null>(null);

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

  /**
   * Save a rename, or do nothing.
   *
   * A room name is a non-empty string or absent — roomSettingsSchema enforces
   * that, so a blank save would 400 and be swallowed by the caller, leaving a
   * Save button that looks live and does nothing.
   */
  const commitRename = (roomId: string) => {
    const next = draftName.trim();
    if (!next) return;
    onRename?.(roomId, next);
    setEditingId(null);
  };

  const copyShareLink = async (roomId: string) => {
    const url = guestHostJoinUrl(roomId);
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

  const openGuestPanel = async (roomId: string) => {
    setGuestPanelId(roomId);
    setMenuOpenId(null);
    try {
      const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`);
      if (!response.ok) {
        setGuestSettings({ guestAccess: false, guestPin: null, guestPinExpiresAt: null, lockoutUntil: null });
        return;
      }
      setGuestSettings(parseGuestSettings(await response.json()));
    } catch {
      setGuestSettings({ guestAccess: false, guestPin: null, guestPinExpiresAt: null, lockoutUntil: null });
    }
  };

  const patchGuestSettings = async (roomId: string, body: Record<string, boolean>) => {
    const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return;
    setGuestSettings(parseGuestSettings(await response.json()));
  };

  return (
    <section className="w-full text-left">
      <h2 className="rooms-h2">Your rooms</h2>
      {loading ? (
        <p
          data-testid="whiteboard-room-list-loading"
          className="app-small"
        >
          Loading roomsâ€¦
        </p>
      ) : rooms.length === 0 ? (
        <p
          data-testid="whiteboard-room-list-empty"
          className="callout quiet"
        >
          No rooms yet. Create one below.
        </p>
      ) : (
        <ul data-testid="whiteboard-room-list" className="room-list">
          {rooms.map((room) => {
            const label = teacherRoomTitle(room);
            const editing = editingId === room.roomId;
            const menuOpen = menuOpenId === room.roomId;
            const copied = copiedId === room.roomId;
            const confirmingDelete = confirmDeleteId === room.roomId;
            const guestPanel = guestPanelId === room.roomId;
            const joinUrl = guestHostJoinUrl(room.roomId);

            return (
              <li
                key={room.roomId}
                className="room-row"
              >
                {editing ? (
                  <div className="row-flex">
                    <input
                      data-testid={`whiteboard-room-name-input-${room.roomId}`}
                      value={draftName}
                      maxLength={100}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          commitRename(room.roomId);
                        }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      autoFocus
                      className="field-input editing"
                    />
                    <div className="btn-gap">
                      <button
                        type="button"
                        data-testid={`whiteboard-room-name-save-${room.roomId}`}
                        disabled={!draftName.trim()}
                        onClick={() => commitRename(room.roomId)}
                        className="btn btn-small"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="btn-outline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : guestPanel ? (
                  <div className="row-stack">
                    <div className="row-flex">
                      <p className="room-name">
                        {label}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setGuestPanelId(null);
                          setGuestSettings(null);
                        }}
                        className="btn-outline"
                      >
                        Close
                      </button>
                    </div>
                    {guestSettings && (
                      <GuestAccessSettings
                        roomId={room.roomId}
                        guestJoinUrl={joinUrl}
                        guestAccess={guestSettings.guestAccess}
                        guestPin={guestSettings.guestPin}
                        guestPinExpiresAt={guestSettings.guestPinExpiresAt}
                        lockoutUntil={guestSettings.lockoutUntil}
                        onEnable={() => { void patchGuestSettings(room.roomId, { guestAccess: true }); }}
                        onDisable={() => { void patchGuestSettings(room.roomId, { guestAccess: false }); }}
                        onRotate={() => { void patchGuestSettings(room.roomId, { rotateGuestPin: true }); }}
                      />
                    )}
                  </div>
                ) : confirmingDelete ? (
                  <div className="row-flex">
                    <p className="room-name confirming">
                      Delete “{label}”?
                    </p>
                    <div className="btn-gap">
                      <button
                        type="button"
                        data-testid={`whiteboard-room-delete-confirm-${room.roomId}`}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onDelete?.(room.roomId);
                        }}
                        className="btn h-11 flex-1 rounded-[0.125rem] px-4 py-0 text-sm sm:flex-none"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="btn-outline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="room-card">
                    <div className="row-flex">
                      <a
                        href={`/whiteboard/${room.roomId}`}
                        data-testid={`whiteboard-room-list-item-${room.roomId}`}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpen(room.roomId);
                        }}
                        className="room-link"
                      >
                        <span className="room-name">
                          {label}
                        </span>
                        {room.createdAt && (
                          <span className="room-date">
                            {formatDate(room.createdAt)}
                          </span>
                        )}
                      </a>

                      <div className="btn-gap">
                        {/*
                          * Out of the menu: letting a student in is the thing a
                          * teacher does before every lesson, and it was sitting
                          * two clicks deep beside Delete -- which for a free
                          * account is the only way to make another room, so the
                          * most routine action and the most destructive one
                          * shared a hidden surface.
                          */}
                        <button
                          type="button"
                          data-testid={`whiteboard-room-guest-${room.roomId}`}
                          onClick={() => {
                            void openGuestPanel(room.roomId);
                          }}
                          className="btn-outline btn-small"
                        >
                          Guest access
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
                              className="room-menu"
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
                                className="menu-item"
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
                                  className="menu-item danger"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/*
                      * Both identifiers, written out.
                      *
                      * A teacher gets a student in by sending the link or by
                      * reading the code down a phone, and neither was on the
                      * screen: the link existed only inside a button that said
                      * "Copied!" and the code only as the heading of a room
                      * nobody had named. So there was no way to check which room
                      * was about to be shared, to read it out, to send it over a
                      * channel the clipboard does not reach, or to notice a copy
                      * that silently failed.
                      */}
                    <dl className="room-share">
                      <div className="room-share-row">
                        <dt className="room-share-label">Join link</dt>
                        <dd className="room-share-value">
                          <span
                            data-testid={`whiteboard-room-url-${room.roomId}`}
                            className="room-url"
                            title={joinUrl}
                          >
                            {joinUrl}
                          </span>
                          <button
                            type="button"
                            data-testid={`whiteboard-room-share-${room.roomId}`}
                            onClick={() => copyShareLink(room.roomId)}
                            title={copied ? 'Copied' : 'Copy join link'}
                            aria-label={copied ? 'Join link copied' : 'Copy join link'}
                            className={copied ? 'copy-icon-btn copied' : 'copy-icon-btn'}
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
                              >
                                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                              </svg>
                            )}
                          </button>
                        </dd>
                      </div>

                      <div className="room-share-row">
                        <dt className="room-share-label">Room code</dt>
                        <dd className="room-share-value">
                          <span
                            data-testid={`whiteboard-room-code-${room.roomId}`}
                            className="room-code"
                          >
                            {room.roomId}
                          </span>
                          <CopyButton value={room.roomId} label="room code" />
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {copyError && (
        <p role="alert" className="app-error nudge-top">
          Could not copy. The join link is written out above — select it and copy it by hand.
        </p>
      )}
    </section>
  );
}
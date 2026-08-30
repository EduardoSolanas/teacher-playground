'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { guestHostJoinUrl } from '@/lib/whiteboard/guestJoinUrl';
import { boardFileName, buildExcalidrawContainer, exportableElements, referencedFileIds, withResolvableImages } from '@/lib/whiteboard/boardExport';
import { collectBoardFiles, elementsFromSceneResponse } from '@/lib/whiteboard/boardDownload';
import { isGuestJoinLockedOut } from '@/lib/whiteboard/guestPin';
import CopyButton from './CopyButton';

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

/** Guest settings for one room, or the closed state if they cannot be read. */
async function readGuestSettings(roomId: string) {
  const closed = { guestAccess: false, guestPin: null, guestPinExpiresAt: null, lockoutUntil: null };
  try {
    const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`);
    if (!response.ok) return closed;
    return parseGuestSettings(await response.json());
  } catch {
    return closed;
  }
}

/**
 * What the PIN line should say about one room.
 *
 * `unknown` is not the same as `off`: until the settings are read, saying a
 * room has no PIN would be a guess, and a teacher acting on it would switch
 * guest access on for a room that already had it.
 */
export type PinState = 'unknown' | 'off' | 'expired' | 'live';

export function guestPinState(
  settings: { guestAccess: boolean; guestPin: string | null; guestPinExpiresAt: number | null } | undefined,
  now: number | null,
): PinState {
  if (!settings || now === null) return 'unknown';
  if (!settings.guestAccess) return 'off';
  if (!settings.guestPin) return 'expired';
  if (settings.guestPinExpiresAt === null || settings.guestPinExpiresAt <= now) return 'expired';
  return 'live';
}

/**
 * The PIN a rotation just replaced, or null if nothing was replaced.
 *
 * Worth showing for one reason: by the time a teacher rotates, the old PIN has
 * usually already been given to somebody. Striking it through says the thing
 * the new PIN on its own does not -- that whoever holds the old one is now
 * locked out and has to be told again.
 *
 * Only a real swap counts. A first PIN replaces nothing, and a response that
 * returns the same digits has not rotated anything, so neither leaves a corpse
 * on the screen.
 */
export function replacedPin(previous: string | null | undefined, next: string | null): string | null {
  if (!previous || !next) return null;
  return previous === next ? null : previous;
}

/**
 * Grouped for reading aloud, which is the only way a PIN reaches a student.
 * Only ever for display: what gets copied is the six digits with no space, so
 * it can be typed straight into the join form.
 */
export function formatGuestPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

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
  const [statsError, setStatsError] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [busyExportId, setBusyExportId] = useState<string | null>(null);
  /*
   * Guest settings for every room on the list, not only the open panel.
   *
   * The PIN is printed on the row, so it has to be known before anything is
   * clicked. Keyed by room so that rotating one room's PIN cannot repaint
   * another's, which a single shared object did the moment a teacher had more
   * than one room.
   */
  const [settingsByRoom, setSettingsByRoom] = useState<
    Record<string, ReturnType<typeof parseGuestSettings>>
  >({});
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  /*
   * Session-only, and deliberately not persisted: a struck-through PIN is
   * a message about something that just happened in front of the teacher.
   * After a reload there is no longer a moment to explain, and a dead PIN
   * sitting on the screen would be nothing but stale noise.
   */
  const [replacedPinByRoom, setReplacedPinByRoom] = useState<Record<string, string>>({});
  /*
   * Null until the browser has run, so the server and the first client render
   * agree: an expiry compared against Date.now() during hydration renders a
   * different string on each side.
   */
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  /*
   * A PIN expires on its own, so the row has to know the state of every room
   * up front rather than when a panel is opened. Rooms already held are not
   * refetched: a rotate writes the fresh value back through patchGuestSettings,
   * and refetching on every render would undo it with a stale read.
   */
  useEffect(() => {
    let cancelled = false;
    for (const room of rooms) {
      if (settingsByRoom[room.roomId]) continue;
      void (async () => {
        const loaded = await readGuestSettings(room.roomId);
        if (cancelled) return;
        setSettingsByRoom((current) => (
          current[room.roomId] ? current : { ...current, [room.roomId]: loaded }
        ));
      })();
    }
    return () => { cancelled = true; };
  }, [rooms, settingsByRoom]);

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

  const patchGuestSettings = async (roomId: string, body: Record<string, boolean>) => {
    setPinBusyId(roomId);
    try {
      const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return;
      const next = parseGuestSettings(await response.json());
      const replaced = replacedPin(settingsByRoom[roomId]?.guestPin, next.guestPin);
      setSettingsByRoom((current) => ({ ...current, [roomId]: next }));
      setReplacedPinByRoom((current) => {
        if (!replaced) {
          if (!current[roomId]) return current;
          const { [roomId]: _dropped, ...rest } = current;
          return rest;
        }
        return { ...current, [roomId]: replaced };
      });
    } finally {
      setPinBusyId((current) => (current === roomId ? null : current));
    }
  };

  /** Hands one built file to the browser as a download. */
  const saveBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchorElement = document.createElement('a');
    anchorElement.href = url;
    anchorElement.download = fileName;
    document.body.appendChild(anchorElement);
    anchorElement.click();
    document.body.removeChild(anchorElement);
    URL.revokeObjectURL(url);
  };

  /**
   * The scene and its pictures, fetched without opening the room.
   *
   * The point of taking a copy from the list is that a teacher archiving a
   * term does not have to enter thirty rooms to do it. The pictures are
   * fetched one at a time and packed into the file, because whoever opens it
   * later will not have a session for the bucket they came from.
   */
  const loadBoard = async (roomId: string) => {
    const response = await ajaxFetch(`/api/whiteboard/room/${roomId}`);
    if (!response.ok) return null;
    const elements = exportableElements(elementsFromSceneResponse(await response.json()));
    const files = await collectBoardFiles(roomId, referencedFileIds(elements), ajaxFetch);
    /*
     * An image whose bytes did not come is dropped with them. Keeping the
     * element would write a file naming a picture that exists nowhere, and a
     * board that imported it would ask the room for those bytes on every
     * change for as long as it stayed open.
     */
    return { elements: withResolvableImages(elements, files), files };
  };

  const downloadBoard = async (room: TeacherRoomSummary) => {
    setExportError(false);
    setBusyExportId(room.roomId);
    try {
      const board = await loadBoard(room.roomId);
      if (!board) {
        setExportError(true);
        return;
      }
      const container = buildExcalidrawContainer(board.elements, board.files, 'teacher-playground');
      saveBlob(
        new Blob([JSON.stringify(container)], { type: 'application/json' }),
        boardFileName(room.roomId, room.name, 'excalidraw', Date.now()),
      );
    } catch {
      setExportError(true);
    } finally {
      setBusyExportId((current) => (current === room.roomId ? null : current));
    }
  };

  /**
   * A picture of the board, rendered without mounting the editor.
   *
   * `exportToBlob` draws a scene on its own, so a board can be turned into a
   * PNG from a list that has no canvas on it. It is imported at the moment it
   * is asked for: it pulls in the editor's rendering code, and this page is
   * the one a teacher opens every lesson and should not be paying for an
   * export nobody has clicked.
   */
  const downloadBoardImage = async (room: TeacherRoomSummary) => {
    setExportError(false);
    setBusyExportId(room.roomId);
    try {
      const board = await loadBoard(room.roomId);
      if (!board || board.elements.length === 0) {
        setExportError(true);
        return;
      }
      const { exportToBlob } = await import('@teacher-playground/excalidraw');
      const files = Object.fromEntries(board.files.map((file) => [file.id, file]));
      const blob = await exportToBlob({
        elements: board.elements as never,
        files: files as never,
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff' } as never,
        mimeType: 'image/png',
      });
      saveBlob(blob, boardFileName(room.roomId, room.name, 'png', Date.now()));
    } catch {
      setExportError(true);
    } finally {
      setBusyExportId((current) => (current === room.roomId ? null : current));
    }
  };

  /*
   * Says so when it fails.
   *
   * The download is a click that produces a file, so a click that produces
   * nothing is indistinguishable from one that has not happened yet -- and the
   * request behind it can fail for ordinary reasons: a room deleted in another
   * tab, a session that has expired since the page was opened.
   */
  const downloadDiagnostics = async (roomId: string) => {
    setStatsError(false);
    try {
      const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/stats`);
      if (!response.ok) {
        setStatsError(true);
        return;
      }
      const stats = await response.json();
      const json = JSON.stringify(stats, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `room-${roomId}-diagnostics.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setStatsError(true);
    }
  };

  return (
    <section className="w-full text-left">
      <h2 className="rooms-h2">Your rooms</h2>
      {loading ? (
        <p
          data-testid="whiteboard-room-list-loading"
          className="app-small"
        >
          Loading rooms…
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
            const joinUrl = guestHostJoinUrl(room.roomId);
            const roomSettings = settingsByRoom[room.roomId];
            const pinState = guestPinState(roomSettings, now);
            const pinBusy = pinBusyId === room.roomId;
            const previousPin = replacedPinByRoom[room.roomId];
            const lockedOut = roomSettings !== undefined && now !== null
              && isGuestJoinLockedOut(roomSettings.lockoutUntil, now);
            const expiryLabel = pinState === 'live' && roomSettings?.guestPinExpiresAt
              ? new Date(roomSettings.guestPinExpiresAt).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })
              : null;
            const deadPin = pinState === 'expired'
              ? roomSettings?.guestPin ?? previousPin
              : previousPin;

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
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`whiteboard-room-download-${room.roomId}`}
                                disabled={busyExportId === room.roomId}
                                onClick={() => {
                                  void downloadBoard(room);
                                  setMenuOpenId(null);
                                }}
                                className="menu-item"
                              >
                                Download board
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`whiteboard-room-image-${room.roomId}`}
                                disabled={busyExportId === room.roomId}
                                onClick={() => {
                                  void downloadBoardImage(room);
                                  setMenuOpenId(null);
                                }}
                                className="menu-item"
                              >
                                Download image
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                data-testid={`whiteboard-room-stats-${room.roomId}`}
                                onClick={() => {
                                  void downloadDiagnostics(room.roomId);
                                  setMenuOpenId(null);
                                }}
                                className="menu-item"
                              >
                                Download diagnostics
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
                        <dt className="room-share-label">Class PIN</dt>
                        <dd className="room-share-value">
                          {pinState === 'unknown' ? (
                            <span className="room-pin-note">Checking…</span>
                          ) : (
                            <>
                              {/*
                                * A dead PIN is struck through rather than merely
                                * recoloured. If the difference between the dead
                                * one and the live one were carried by red against
                                * green it would not be carried at all for a reader
                                * who cannot separate those hues; the line through
                                * the digits says it without relying on colour, and
                                * the red only agrees with it.
                                *
                                * Two different PINs can be dead here. The one a
                                * rotation just replaced, which the teacher has
                                * probably already given out, and one that ran out
                                * of time on its own. Both matter for the same
                                * reason: somebody is holding digits that no longer
                                * work and has to be told again.
                                */}
                              {deadPin && (
                                <span
                                  data-testid={`whiteboard-room-pin-old-${room.roomId}`}
                                  className="room-pin-old"
                                >
                                  {formatGuestPin(deadPin)}
                                </span>
                              )}

                              {pinState === 'live' && roomSettings?.guestPin ? (
                                <>
                                  <span
                                    data-testid={`whiteboard-room-pin-${room.roomId}`}
                                    className="room-pin"
                                  >
                                    {formatGuestPin(roomSettings.guestPin)}
                                  </span>
                                  <CopyButton value={roomSettings.guestPin} label="class PIN" />
                                </>
                              ) : (
                                <span className="room-pin-note">
                                  {pinState === 'expired' ? 'Expired' : 'Not switched on'}
                                </span>
                              )}

                              {/*
                                * Offered in every state, including while a PIN is
                                * live: a teacher who has finished with a student,
                                * or who has watched the digits travel further than
                                * they meant, needs to cut off whoever holds the
                                * old one without first going and finding a panel.
                                */}
                              <button
                                type="button"
                                data-testid={`whiteboard-room-pin-new-${room.roomId}`}
                                disabled={pinBusy}
                                onClick={() => {
                                  void patchGuestSettings(
                                    room.roomId,
                                    pinState === 'off'
                                      ? { guestAccess: true }
                                      : { guestAccess: true, rotateGuestPin: true },
                                  );
                                }}
                                className="btn-outline btn-small"
                              >
                                {pinBusy
                                  ? 'Working…'
                                  : pinState === 'off' ? 'Create PIN' : 'New PIN'}
                              </button>

                              {/*
                                * On the PIN line and pushed to its far end.
                                * Everything here is about one thing -- the six
                                * digits that let a student in -- so the switch
                                * that stops them working belongs beside them
                                * rather than adrift at the foot of the card.
                                * The distance across the line is what keeps it
                                * away from the controls that hand access out.
                                */}
                              {roomSettings?.guestAccess && (
                                <button
                                  type="button"
                                  data-testid={`whiteboard-room-guest-off-${room.roomId}`}
                                  disabled={pinBusy}
                                  onClick={() => {
                                    void patchGuestSettings(room.roomId, { guestAccess: false });
                                  }}
                                  className="btn-outline btn-small room-pin-off"
                                >
                                  Turn off guest join
                                </button>
                              )}

                              {previousPin && pinState === 'live' && (
                                <span className="room-pin-note">
                                  Anyone holding the old PIN is locked out — send this one.
                                </span>
                              )}
                              {expiryLabel && !previousPin && (
                                <span className="room-pin-note">
                                  Stops working {expiryLabel}
                                </span>
                              )}
                              {/*
                                * Carried over from the panel this replaced. It
                                * is the only explanation a teacher gets for a
                                * student who is typing the right digits and
                                * still cannot get in.
                                */}
                              {lockedOut && (
                                <span
                                  data-testid={`whiteboard-room-lockout-${room.roomId}`}
                                  className="room-pin-note room-pin-warn"
                                >
                                  Too many wrong PIN attempts — join is locked. A new PIN unlocks it.
                                </span>
                              )}
                            </>
                          )}
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

      {exportError && (
        <p role="alert" className="app-error nudge-top">
          Could not build that download. The room may have been deleted, or the session may
          have expired — reload and try again.
        </p>
      )}

      {statsError && (
        <p role="alert" className="app-error nudge-top">
          Could not build the diagnostics for that room. It may have been deleted, or the
          session may have expired — reload and try again.
        </p>
      )}

      {copyError && (
        <p role="alert" className="app-error nudge-top">
          Could not copy. The join link is written out above — select it and copy it by hand.
        </p>
      )}
    </section>
  );
}
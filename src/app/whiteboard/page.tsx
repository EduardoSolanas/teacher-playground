'use client';

import { useState, useCallback, useEffect } from 'react';
import { generateRoomId } from '@/lib/crypto/randomId';
import { navigateToWhiteboardRoom } from '@/lib/whiteboard/roomPath';
import { getStablePeerId } from '@/lib/whiteboard/peerId';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import TeacherRoomList, {
  type TeacherRoomSummary,
} from '@/components/whiteboard/TeacherRoomList';
import { UserProfileMenu } from '@/components/whiteboard/UserProfileMenu';
import {
  DEFAULT_MAX_USERS,
  FREE_MAX_ROOMS,
  FREE_MAX_USERS,
  MIN_MAX_USERS,
} from '@/lib/plan/limits';

const MIN_USERS = MIN_MAX_USERS;
const MAX_USERS = FREE_MAX_USERS;

function parseTeacherRooms(payload: unknown): TeacherRoomSummary[] {
  if (!payload || typeof payload !== 'object') return [];
  const rooms = Array.isArray(payload)
    ? payload
    : (payload as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  const parsed: TeacherRoomSummary[] = [];
  for (const entry of rooms) {
    if (!entry || typeof entry !== 'object') continue;
    const roomId = (entry as { roomId?: unknown }).roomId;
    if (typeof roomId !== 'string' || roomId.length === 0) continue;
    const name = (entry as { name?: unknown }).name;
    const createdAt = (entry as { createdAt?: unknown }).createdAt;
    parsed.push({
      roomId,
      name: typeof name === 'string' ? name : null,
      createdAt: typeof createdAt === 'number' ? createdAt : undefined,
    });
  }
  return parsed;
}

export default function WhiteboardRoute() {
  const [maxUsers, setMaxUsers] = useState(DEFAULT_MAX_USERS);
  const [newRoomName, setNewRoomName] = useState('');
  const [creationTimes, setCreationTimes] = useState<number[]>([]);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<TeacherRoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [hostDisplayName, setHostDisplayName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [roomsResponse, sessionResponse] = await Promise.all([
          ajaxFetch('/api/whiteboard/rooms'),
          ajaxFetch('/auth/session/current'),
        ]);
        if (!cancelled && roomsResponse.ok) {
          const payload: unknown = await roomsResponse.json();
          setRooms(parseTeacherRooms(payload));
        } else if (!cancelled) {
          setRooms([]);
        }
        if (!cancelled && sessionResponse.ok) {
          const session: unknown = await sessionResponse.json();
          const displayName = session && typeof session === 'object'
            ? (session as { displayName?: unknown }).displayName
            : undefined;
          setHostDisplayName(typeof displayName === 'string' ? displayName : null);
        }
      } catch {
        if (!cancelled) setRooms([]);
      } finally {
        if (!cancelled) setRoomsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const atRoomLimit = !roomsLoading && rooms.length >= FREE_MAX_ROOMS;
  const createDisabled = isCreatingRoom || atRoomLimit;

  const handleCreateRoom = useCallback(async () => {
    if (isCreatingRoom || rooms.length >= FREE_MAX_ROOMS) return;

    const now = Date.now();
    const recent = creationTimes.filter(t => now - t < 60000);
    if (recent.length >= 10) {
      setCreateError('Too many rooms created. Please wait a minute and try again.');
      return;
    }

    setCreateError(null);
    setIsCreatingRoom(true);
    setCreationTimes([...recent, now]);
    const roomId = generateRoomId();
    const hostPeerId = getStablePeerId(roomId);

    try {
      const created = await ajaxFetch(`/api/whiteboard/room/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
      });

      if (!created.ok) {
        if (created.status === 402) {
          setCreateError('Free accounts can keep one room. Delete it to create another.');
          setCreationTimes(recent);
          setIsCreatingRoom(false);
          return;
        }
        throw new Error('Failed to create room');
      }

      const settings = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Naming is optional: an unnamed room falls back to its code, which is
        // more use than auto-naming every room after the same teacher.
        //
        // A blank name omits the key rather than sending null or ''. The
        // settings schema types name as a non-empty string, so both are
        // rejected outright and the whole room creation fails.
        body: JSON.stringify({
          maxUsers,
          hostPeerId,
          ...(newRoomName.trim() ? { name: newRoomName.trim() } : {}),
        }),
      });

      if (!settings.ok) {
        if (settings.status === 402) {
          setCreateError('Free accounts allow the host plus one student.');
          setCreationTimes(recent);
          setIsCreatingRoom(false);
          return;
        }
        throw new Error('Failed to create room');
      }

      navigateToWhiteboardRoom(roomId);
    } catch {
      setCreationTimes(recent);
      setIsCreatingRoom(false);
      setCreateError('Room creation failed. Please try again.');
    }
  }, [creationTimes, isCreatingRoom, maxUsers, newRoomName, rooms.length]);

  const refreshRooms = useCallback(async () => {
    const response = await ajaxFetch('/api/whiteboard/rooms');
    if (!response.ok) {
      setRooms([]);
      return;
    }
    const payload: unknown = await response.json();
    setRooms(parseTeacherRooms(payload));
  }, []);

  const handleRename = useCallback(
    async (roomId: string, nextName: string) => {
      const response = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) return;
      await refreshRooms();
    },
    [refreshRooms],
  );

  const handleDelete = useCallback(
    async (roomId: string) => {
      setDeleteError(null);
      const remove = () => ajaxFetch(`/api/whiteboard/room/${roomId}`, { method: 'DELETE' });

      let response = await remove();
      // Deleting a room is a destructive action, so the Worker requires a
      // session created or confirmed in the last five minutes and answers 403
      // otherwise. Re-confirm and retry once, the same way account erase does —
      // without this the button silently did nothing for any teacher who had
      // been signed in longer than five minutes.
      if (response.status === 403) {
        const confirmed = await ajaxFetch('/auth/session/confirm', { method: 'POST' });
        if (confirmed.ok) response = await remove();
      }
      if (!response.ok) {
        setDeleteError('Could not delete that room. Try again.');
        return;
      }
      await refreshRooms();
    },
    [refreshRooms],
  );

  const stepUsers = (delta: number) =>
    setMaxUsers((current) => Math.max(MIN_USERS, Math.min(MAX_USERS, current + delta)));

  return (
    <div className="app-screen pt-[calc(3rem+env(safe-area-inset-top))]">
      <header
        data-testid="whiteboard-rooms-top-nav"
        className="fixed inset-x-0 top-0 z-[1100] flex h-[calc(3rem+env(safe-area-inset-top))] items-center justify-end border-b border-slate-700/80 bg-slate-900/95 pt-[env(safe-area-inset-top)] text-slate-200 shadow-lg shadow-slate-950/20 backdrop-blur-md"
      >
        <div className="flex h-full items-center pr-[max(0.5rem,env(safe-area-inset-right))]">
          <UserProfileMenu
            displayName={hostDisplayName}
            onDisplayNameChange={setHostDisplayName}
            showDisplayName={false}
            triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-400 hover:bg-slate-700 active:bg-slate-600"
          />
        </div>
      </header>

      <main className="app-main">
        <div className="paper-card">
          <h1 className="app-title">
            Collaborative Whiteboard
          </h1>
          <p className="app-sub">
            Create a room to start collaborating in real-time
          </p>

          <div className="mt-6">
            <TeacherRoomList
              rooms={rooms}
              loading={roomsLoading}
              onOpen={navigateToWhiteboardRoom}
              onRename={handleRename}
              onDelete={handleDelete}
            />
            {deleteError && (
              <p
                role="alert"
                data-testid="whiteboard-room-delete-error"
                className="app-error"
              >
                {deleteError}
              </p>
            )}
          </div>

          <div className="section-sep">
            <h2 className="app-h2">New room</h2>

            <div className="form-panel">
            <div className="field-group">
              <label htmlFor="whiteboard-room-name" className="app-label">
                Room name <span className="app-small">(optional)</span>
              </label>
              <input
                id="whiteboard-room-name"
                data-testid="whiteboard-new-room-name"
                type="text"
                value={newRoomName}
                maxLength={100}
                placeholder="Leave blank to use the room code"
                onChange={(event) => setNewRoomName(event.target.value)}
                className="field-input nudge-top"
              />
            </div>

            <div className="field-group">
              <label
                htmlFor="whiteboard-max-users"
                className="app-label"
              >
                People allowed
              </label>
              <div className="stepper">
                <button
                  type="button"
                  aria-label="Fewer people"
                  onClick={() => stepUsers(-1)}
                  disabled={maxUsers <= MIN_USERS}
                  className="stepper-btn"
                >
                  &#8722;
                </button>
                <input
                  id="whiteboard-max-users"
                  type="number"
                  min={MIN_USERS}
                  max={MAX_USERS}
                  value={maxUsers}
                  onChange={(e) =>
                    setMaxUsers(
                      Math.max(MIN_USERS, Math.min(MAX_USERS, Number(e.target.value) || MIN_USERS)),
                    )
                  }
                  className="stepper-input [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  aria-label="More people"
                  onClick={() => stepUsers(1)}
                  disabled={maxUsers >= MAX_USERS}
                  className="stepper-btn"
                >
                  +
                </button>
              </div>
              <p className="app-small">
                Includes you. Free accounts allow one student.
              </p>
            </div>
            </div>

            {(createError || atRoomLimit) && (
              <p
                role="alert"
                data-testid="whiteboard-create-room-error"
                className="callout app-error"
              >
                {createError
                  ?? 'Free accounts can keep one room. Delete it to create another.'}
              </p>
            )}

            <button
              type="button"
              data-testid="whiteboard-create-room-btn"
              onClick={handleCreateRoom}
              disabled={createDisabled}
              aria-busy={isCreatingRoom}
              className="btn btn-block"
            >
              {isCreatingRoom && (
                <span aria-hidden="true" className="spinner" />
              )}
              {isCreatingRoom ? 'Creating room...' : 'Create Room'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

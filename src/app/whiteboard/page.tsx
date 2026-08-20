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
import { roomNameForHostDisplayName } from '@/lib/access/accessDisplayName';
import {
  DEFAULT_MAX_USERS,
  FREE_MAX_ROOMS,
  FREE_MAX_USERS,
  MIN_MAX_USERS,
} from '@/lib/plan/limits';

const ADJECTIVES = [
  'Bright', 'Calm', 'Swift', 'Warm', 'Bold',
  'Fresh', 'Clear', 'Keen', 'Neat', 'Vivid',
  'Cozy', 'Lively', 'Gentle', 'Snappy', 'Curious',
];

const NOUNS = [
  'Canvas', 'Studio', 'Board', 'Space', 'Workshop',
  'Lab', 'Room', 'Desk', 'Corner', 'Garden',
  'Atelier', 'Haven', 'Nook', 'Forum', 'Stage',
];

const MIN_USERS = MIN_MAX_USERS;
const MAX_USERS = FREE_MAX_USERS;

function generateRoomName(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const adj = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  return `${adj} ${noun}`;
}

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
        body: JSON.stringify({ maxUsers, hostPeerId, name: hostDisplayName
          ? roomNameForHostDisplayName(hostDisplayName)
          : generateRoomName() }),
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
  }, [creationTimes, hostDisplayName, isCreatingRoom, maxUsers, rooms.length]);

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
    <div className="flex min-h-[100dvh] flex-col bg-[var(--paper)] text-[var(--ink)] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-0 sm:px-6">
      <div aria-hidden="true" className="brand-topline" />
      <header className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between gap-3 py-4 sm:py-5">
        <span className="brand flex min-w-0 items-baseline gap-2">
          <span className="mark text-lg sm:text-xl">
            Teacher <u>Playground</u>
          </span>
        </span>

        <UserProfileMenu
          displayName={hostDisplayName}
          onDisplayNameChange={setHostDisplayName}
        />
      </header>


      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col sm:justify-center">
        <div className="w-full rounded-[3px] border border-[var(--line)] bg-white p-6 shadow-[5px_6px_0_rgba(38,36,31,0.06)] sm:p-8">
          <h1 className="serif text-balance text-center text-[26px] font-normal leading-tight tracking-tight text-[var(--ink)] sm:text-4xl">
            Collaborative Whiteboard
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-balance text-center text-sm leading-relaxed text-[var(--ink2)] sm:max-w-sm sm:text-base">
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
                className="mt-3 text-[13px] font-medium text-red-600"
              >
                {deleteError}
              </p>
            )}
          </div>

          <div className="mt-7 border-t border-[var(--line)] pt-6">
            <h2 className="serif text-xl font-normal text-[var(--ink)]">New room</h2>

            <div className="mt-4">
              <label
                htmlFor="whiteboard-max-users"
                className="block text-[13px] font-semibold text-[var(--ink2)]"
              >
                People allowed
              </label>
              <div className="mt-1.5 flex max-w-[240px] items-center gap-2">
                <button
                  type="button"
                  aria-label="Fewer people"
                  onClick={() => stepUsers(-1)}
                  disabled={maxUsers <= MIN_USERS}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[2px] border border-[var(--ink)] bg-white text-xl font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper2)] disabled:opacity-40 disabled:hover:bg-white"
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
                  className="h-11 w-full min-w-0 rounded-[2px] border border-[var(--line)] bg-white px-3 text-center text-base font-semibold text-[var(--ink)] outline-none transition-colors focus:border-[var(--blue)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  aria-label="More people"
                  onClick={() => stepUsers(1)}
                  disabled={maxUsers >= MAX_USERS}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[2px] border border-[var(--ink)] bg-white text-xl font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper2)] disabled:opacity-40 disabled:hover:bg-white"
                >
                  +
                </button>
              </div>
              <p className="mt-2 text-[12px] text-[var(--mut)]">
                Includes you. Free accounts allow one student.
              </p>
            </div>

            {(createError || atRoomLimit) && (
              <p
                role="alert"
                data-testid="whiteboard-create-room-error"
                className="draft mt-4 text-[13px] font-medium"
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
              className="btn mt-5 inline-flex h-12 w-full items-center justify-center gap-2.5 text-[15px]"
            >
              {isCreatingRoom && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 rounded-full border-2 border-white/45 border-t-white"
                  style={{ animation: 'whiteboard-spin 0.8s linear infinite' }}
                />
              )}
              {isCreatingRoom ? 'Creating room...' : 'Create Room'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

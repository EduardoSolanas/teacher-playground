'use client';

import { useState, useCallback, useEffect } from 'react';
import { generateRoomId } from '@/lib/crypto/randomId';
import { navigateToWhiteboardRoom } from '@/lib/whiteboard/roomPath';
import { getStablePeerId } from '@/lib/whiteboard/peerId';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import TeacherRoomList, {
  type TeacherRoomSummary,
} from '@/components/whiteboard/TeacherRoomList';
import { completeSignOut } from '@/lib/identity/completeSignOut';

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

const MIN_USERS = 1;
const MAX_USERS = 10;

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
  const [roomName, setRoomName] = useState(() => generateRoomName());
  const [maxUsers, setMaxUsers] = useState(3);
  const [creationTimes, setCreationTimes] = useState<number[]>([]);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<TeacherRoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await ajaxFetch('/api/whiteboard/rooms');
        if (!response.ok) {
          if (!cancelled) setRooms([]);
          return;
        }
        const payload: unknown = await response.json();
        if (!cancelled) setRooms(parseTeacherRooms(payload));
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

  const handleCreateRoom = useCallback(async () => {
    if (isCreatingRoom) return;

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
        throw new Error('Failed to create room');
      }

      const settings = await ajaxFetch(`/api/whiteboard/room/${roomId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxUsers, hostPeerId, name: roomName.trim() || null }),
      });

      if (!settings.ok) {
        throw new Error('Failed to create room');
      }

      navigateToWhiteboardRoom(roomId);
    } catch {
      setCreationTimes(recent);
      setIsCreatingRoom(false);
      setCreateError('Room creation failed. Please try again.');
    }
  }, [creationTimes, isCreatingRoom, maxUsers, roomName]);

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
      const response = await ajaxFetch(`/api/whiteboard/room/${roomId}`, {
        method: 'DELETE',
      });
      if (!response.ok) return;
      await refreshRooms();
    },
    [refreshRooms],
  );

  const handleSignOut = useCallback(async () => {
    await completeSignOut({
      logout: () => ajaxFetch('/auth/session/logout', { method: 'POST' }),
      navigate: (path) => {
        window.location.assign(path);
      },
    });
  }, []);

  const stepUsers = (delta: number) =>
    setMaxUsers((current) => Math.max(MIN_USERS, Math.min(MAX_USERS, current + delta)));

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[linear-gradient(135deg,#667eea_0%,#764ba2_100%)] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
      <header className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between gap-3 pb-4 sm:pb-6">
        <span className="flex min-w-0 items-center gap-2 text-white">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/15 text-base ring-1 ring-white/25"
          >
            &#9998;
          </span>
          <span className="truncate text-sm font-semibold tracking-tight sm:text-base">
            Teacher Playground
          </span>
        </span>

        <button
          type="button"
          data-testid="whiteboard-logout-btn"
          onClick={handleSignOut}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/20 active:bg-white/25 sm:px-4"
        >
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
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="m16 17 5-5-5-5" />
            <path d="M21 12H9" />
          </svg>
          Sign out
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col sm:justify-center">
        <div className="w-full rounded-2xl bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.28)] sm:rounded-3xl sm:p-8">
          <h1 className="text-balance text-center text-[22px] font-bold leading-tight tracking-tight text-slate-900 sm:text-3xl">
            Collaborative Whiteboard
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-balance text-center text-sm leading-relaxed text-slate-500 sm:max-w-sm sm:text-base">
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
          </div>

          <div className="mt-6 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70 sm:p-5">
            <h2 className="text-base font-bold text-slate-900">New room</h2>

            <div className="mt-4">
              <label
                htmlFor="whiteboard-new-room-name"
                className="block text-[13px] font-semibold text-slate-600"
              >
                Room name
              </label>
              <input
                id="whiteboard-new-room-name"
                type="text"
                data-testid="whiteboard-room-name-input"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value.slice(0, 100))}
                placeholder="e.g. Maths Lesson"
                className="mt-1.5 h-11 w-full rounded-xl border-2 border-slate-200 bg-white px-3 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-500"
              />
            </div>

            <div className="mt-4">
              <label
                htmlFor="whiteboard-max-users"
                className="block text-[13px] font-semibold text-slate-600"
              >
                People allowed
              </label>
              <div className="mt-1.5 flex max-w-[240px] items-center gap-2">
                <button
                  type="button"
                  aria-label="Fewer people"
                  onClick={() => stepUsers(-1)}
                  disabled={maxUsers <= MIN_USERS}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 border-slate-200 bg-white text-xl font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white"
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
                  className="h-11 w-full min-w-0 rounded-xl border-2 border-slate-200 bg-white px-3 text-center text-base font-semibold text-slate-900 outline-none transition-colors focus:border-indigo-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  aria-label="More people"
                  onClick={() => stepUsers(1)}
                  disabled={maxUsers >= MAX_USERS}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 border-slate-200 bg-white text-xl font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white"
                >
                  +
                </button>
              </div>
            </div>

            {createError && (
              <p
                role="alert"
                data-testid="whiteboard-create-room-error"
                className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-[13px] font-medium text-red-700 ring-1 ring-red-200"
              >
                {createError}
              </p>
            )}

            <button
              type="button"
              data-testid="whiteboard-create-room-btn"
              onClick={handleCreateRoom}
              disabled={isCreatingRoom}
              aria-busy={isCreatingRoom}
              className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-[linear-gradient(135deg,#667eea_0%,#764ba2_100%)] text-[15px] font-semibold text-white shadow-lg shadow-indigo-500/25 transition-opacity hover:opacity-95 disabled:cursor-wait disabled:bg-[linear-gradient(135deg,#94a3b8_0%,#64748b_100%)] disabled:opacity-85 disabled:shadow-none"
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

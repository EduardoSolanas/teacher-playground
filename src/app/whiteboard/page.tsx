'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { generateRoomId } from '@/lib/crypto/randomId';
import { getStablePeerId } from '@/lib/whiteboard/peerId';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import TeacherRoomList, {
  type TeacherRoomSummary,
} from '@/components/whiteboard/TeacherRoomList';

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

function generateRoomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
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
  const router = useRouter();
  const [roomName, setRoomName] = useState(() => generateRoomName());
  const [maxUsers, setMaxUsers] = useState(3);
  const [creationTimes, setCreationTimes] = useState<number[]>([]);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
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
      alert('Too many rooms created. Please wait.');
      return;
    }

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

      router.push(`/whiteboard/${roomId}`);
    } catch {
      setCreationTimes(recent);
      setIsCreatingRoom(false);
      alert('Room creation failed. Please try again.');
    }
  }, [creationTimes, isCreatingRoom, maxUsers, roomName, router]);

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

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: 24,
      }}
    >
      <button
        data-testid="whiteboard-logout-btn"
        onClick={async () => {
          try {
            await ajaxFetch('/auth/session/logout', { method: 'POST' });
          } catch {}
          window.location.href = 'https://ha-smart-home.cloudflareaccess.com/cdn-cgi/access/logout';
        }}
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          padding: '8px 16px',
          border: '1px solid rgba(255,255,255,0.3)',
          borderRadius: 8,
          background: 'rgba(0,0,0,0.2)',
          backdropFilter: 'blur(8px)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          zIndex: 1100,
        }}
      >
        Sign out
      </button>
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: '48px 40px',
          maxWidth: 640,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
      >
        <h1
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: '#1a1a2e',
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          Collaborative Whiteboard
        </h1>
        <p
          style={{
            fontSize: 16,
            color: '#666',
            marginBottom: 36,
            lineHeight: 1.5,
            textAlign: 'center',
          }}
        >
          Create a room to start collaborating in real-time
        </p>

        <TeacherRoomList
          rooms={rooms}
          loading={roomsLoading}
          onOpen={(roomId) => router.push(`/whiteboard/${roomId}`)}
          onRename={handleRename}
          onDelete={handleDelete}
        />

        <div
          style={{
            background: '#f8f9fa',
            borderRadius: 12,
            padding: '24px',
            marginTop: rooms.length > 0 ? 24 : 0,
          }}
        >
          <h2
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#1a1a2e',
              margin: '0 0 16px',
            }}
          >
            New room
          </h2>

          <label
            style={{
              display: 'block',
              color: '#4b5563',
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Room name
          </label>
          <input
            type="text"
            data-testid="whiteboard-room-name-input"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value.slice(0, 100))}
            placeholder="e.g. Maths Lesson"
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '2px solid #e0e0e0',
              borderRadius: 8,
              fontSize: 15,
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: 12,
            }}
          />

          <label
            style={{
              display: 'block',
              color: '#4b5563',
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            People allowed
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={maxUsers}
            onChange={(e) => setMaxUsers(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '2px solid #e0e0e0',
              borderRadius: 8,
              fontSize: 15,
              textAlign: 'center',
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: 16,
            }}
          />

          <button
            data-testid="whiteboard-create-room-btn"
            onClick={handleCreateRoom}
            disabled={isCreatingRoom}
            aria-busy={isCreatingRoom}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              width: '100%',
              padding: '12px 24px',
              border: 'none',
              borderRadius: 8,
              background: isCreatingRoom
                ? 'linear-gradient(135deg, #94a3b8 0%, #64748b 100%)'
                : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: '#fff',
              fontSize: 15,
              fontWeight: 600,
              cursor: isCreatingRoom ? 'wait' : 'pointer',
              opacity: isCreatingRoom ? 0.85 : 1,
            }}
          >
            {isCreatingRoom && (
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 16,
                  border: '2px solid rgba(255,255,255,0.45)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'whiteboard-spin 0.8s linear infinite',
                  flexShrink: 0,
                }}
              />
            )}
            {isCreatingRoom ? 'Creating room...' : 'Create Room'}
          </button>
        </div>
      </div>
    </div>
  );
}

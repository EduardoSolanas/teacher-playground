'use client';

import { useState } from 'react';

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

export default function TeacherRoomList({
  rooms,
  loading = false,
  onOpen,
  onRename,
}: {
  rooms: TeacherRoomSummary[];
  loading?: boolean;
  onOpen: (roomId: string) => void;
  onRename?: (roomId: string, nextName: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  return (
    <section style={{ width: '100%', textAlign: 'left', marginBottom: 24 }}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: '#1a1a2e',
          margin: '0 0 12px',
        }}
      >
        Your rooms
      </h2>
      {loading ? (
        <p data-testid="whiteboard-room-list-loading" style={{ color: '#666', margin: 0 }}>
          Loading rooms…
        </p>
      ) : rooms.length === 0 ? (
        <p data-testid="whiteboard-room-list-empty" style={{ color: '#666', margin: 0 }}>
          No rooms yet. Create one below.
        </p>
      ) : (
        <ul
          data-testid="whiteboard-room-list"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            width: '100%',
          }}
        >
          {rooms.map((room, index) => {
            const label = teacherRoomTitle(room);
            const editing = editingId === room.roomId;
            return (
              <li
                key={room.roomId}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '12px 0',
                  borderTop: index === 0 ? '1px solid #eee' : undefined,
                  borderBottom: '1px solid #eee',
                }}
              >
                <a
                  href={`/whiteboard/${room.roomId}`}
                  data-testid={`whiteboard-room-list-item-${room.roomId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(room.roomId);
                  }}
                  style={{
                    flex: 1,
                    color: '#1a1a2e',
                    fontSize: 16,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  {label}
                </a>
                {editing ? (
                  <>
                    <input
                      data-testid={`whiteboard-room-name-input-${room.roomId}`}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flex: 1,
                        padding: '10px 12px',
                        border: '2px solid #667eea',
                        borderRadius: 10,
                        fontSize: 14,
                      }}
                    />
                    <button
                      type="button"
                      data-testid={`whiteboard-room-name-save-${room.roomId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRename?.(room.roomId, draftName);
                        setEditingId(null);
                      }}
                      style={{
                        padding: '10px 12px',
                        border: 'none',
                        borderRadius: 10,
                        background: '#667eea',
                        color: '#fff',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid={`whiteboard-room-rename-${room.roomId}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(room.roomId);
                      setDraftName(room.name?.trim() ?? '');
                    }}
                    style={{
                      padding: '10px 12px',
                      border: '2px solid #e0e0e0',
                      borderRadius: 10,
                      background: '#fff',
                      color: '#1a1a2e',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Rename
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

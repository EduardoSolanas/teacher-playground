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

  const copyShareLink = (roomId: string) => {
    const url = `${window.location.origin}/whiteboard/${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(roomId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <section style={{ width: '100%', textAlign: 'left' }}>
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
        <p data-testid="whiteboard-room-list-empty" style={{ color: '#999', margin: 0, fontSize: 14 }}>
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
          {rooms.map((room) => {
            const label = teacherRoomTitle(room);
            const editing = editingId === room.roomId;
            const menuOpen = menuOpenId === room.roomId;
            const copied = copiedId === room.roomId;
            return (
              <li
                key={room.roomId}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '12px 14px',
                  borderRadius: 10,
                  marginBottom: 4,
                  background: '#f8f9fa',
                  position: 'relative',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f1f3')}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#f8f9fa';
                  if (!editing) setMenuOpenId(null);
                }}
              >
                {editing ? (
                  <div style={{ flex: 1, display: 'flex', gap: 8 }}>
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
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        border: '2px solid #667eea',
                        borderRadius: 6,
                        fontSize: 14,
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      data-testid={`whiteboard-room-name-save-${room.roomId}`}
                      onClick={() => {
                        onRename?.(room.roomId, draftName);
                        setEditingId(null);
                      }}
                      style={{
                        padding: '6px 14px',
                        border: 'none',
                        borderRadius: 6,
                        background: '#667eea',
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid #ddd',
                        borderRadius: 6,
                        background: '#fff',
                        color: '#666',
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
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
                        fontSize: 15,
                        fontWeight: 600,
                        textDecoration: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span>{label}</span>
                      {room.createdAt && (
                        <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>
                          {formatDate(room.createdAt)}
                        </span>
                      )}
                    </a>

                    <button
                      type="button"
                      data-testid={`whiteboard-room-share-${room.roomId}`}
                      onClick={() => copyShareLink(room.roomId)}
                      title="Copy share link"
                      style={{
                        padding: '6px 12px',
                        border: '1px solid #ddd',
                        borderRadius: 6,
                        background: copied ? '#e8f5e9' : '#fff',
                        color: copied ? '#2e7d32' : '#555',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {copied ? 'Copied!' : 'Share link'}
                    </button>

                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        data-testid={`whiteboard-room-menu-${room.roomId}`}
                        onClick={() => setMenuOpenId(menuOpen ? null : room.roomId)}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #ddd',
                          borderRadius: 6,
                          background: '#fff',
                          color: '#888',
                          fontSize: 16,
                          cursor: 'pointer',
                          lineHeight: 1,
                        }}
                      >
                        &#8943;
                      </button>
                      {menuOpen && (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            right: 0,
                            marginTop: 4,
                            background: '#fff',
                            border: '1px solid #e0e0e0',
                            borderRadius: 8,
                            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                            zIndex: 10,
                            minWidth: 120,
                            overflow: 'hidden',
                          }}
                        >
                          <button
                            type="button"
                            data-testid={`whiteboard-room-rename-${room.roomId}`}
                            onClick={() => {
                              setEditingId(room.roomId);
                              setDraftName(room.name?.trim() ?? '');
                              setMenuOpenId(null);
                            }}
                            style={{
                              display: 'block',
                              width: '100%',
                              padding: '10px 14px',
                              border: 'none',
                              background: 'none',
                              textAlign: 'left',
                              fontSize: 13,
                              color: '#333',
                              cursor: 'pointer',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                          >
                            Rename
                          </button>
                          {onDelete && (
                            <button
                              type="button"
                              data-testid={`whiteboard-room-delete-${room.roomId}`}
                              onClick={() => {
                                setMenuOpenId(null);
                                if (confirm(`Delete "${label}"?`)) {
                                  onDelete(room.roomId);
                                }
                              }}
                              style={{
                                display: 'block',
                                width: '100%',
                                padding: '10px 14px',
                                border: 'none',
                                background: 'none',
                                textAlign: 'left',
                                fontSize: 13,
                                color: '#dc2626',
                                cursor: 'pointer',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = '#fef2f2')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getStablePeerId } from '@/lib/whiteboard/peerId';

export default function WhiteboardRoute() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');
  const [maxUsers, setMaxUsers] = useState(3);
  const [creationTimes, setCreationTimes] = useState<number[]>([]);

  const generateRoomId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }, []);

  const isValidRoomCode = (code: string): boolean => /^[a-zA-Z0-9_-]{1,20}$/.test(code);

  const handleCreateRoom = useCallback(async () => {
    const now = Date.now();
    const recent = creationTimes.filter(t => now - t < 60000);
    if (recent.length >= 10) {
      alert('Too many rooms created. Please wait.');
      return;
    }
    setCreationTimes([...recent, now]);
    const roomId = generateRoomId();
    const hostPeerId = getStablePeerId(roomId);
    await fetch(`/api/whiteboard/room/${roomId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elements: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        maxUsers,
        hostPeerId,
      }),
    });
    router.push(`/whiteboard/${roomId}`);
  }, [creationTimes, generateRoomId, maxUsers, router]);

  const handleJoinRoom = useCallback(() => {
    if (joinCode.trim().length > 0 && isValidRoomCode(joinCode.trim())) {
      router.push(`/whiteboard/${joinCode.trim()}`);
    }
  }, [joinCode, router]);

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
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: '48px 40px',
          maxWidth: 480,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: '#1a1a2e',
            marginBottom: 8,
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
          }}
        >
          Create or join a room to start collaborating in real-time
        </p>

        <button
          data-testid="whiteboard-create-room-btn"
          onClick={handleCreateRoom}
          style={{
            display: 'block',
            width: '100%',
            padding: '14px 24px',
            border: 'none',
            borderRadius: 10,
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: '#fff',
            fontSize: 16,
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: 16,
          }}
        >
          Create Room
        </button>

        <label
          style={{
            display: 'block',
            textAlign: 'left',
            color: '#4b5563',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
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
            padding: '12px 14px',
            border: '2px solid #e0e0e0',
            borderRadius: 10,
            fontSize: 16,
            textAlign: 'center',
            outline: 'none',
            boxSizing: 'border-box',
            marginBottom: 16,
          }}
        />

        <div style={{ margin: '24px 0' }}>
          <div
            style={{
              height: 1,
              background: '#e0e0e0',
              marginBottom: 24,
            }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Enter room code"
            data-testid="whiteboard-room-code-input"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.slice(0, 20))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleJoinRoom();
            }}
            style={{
              width: '100%',
              padding: '14px 16px',
              border: '2px solid #e0e0e0',
              borderRadius: 10,
              fontSize: 16,
              textAlign: 'center',
              letterSpacing: 2,
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => (e.target.style.borderColor = '#667eea')}
            onBlur={(e) => (e.target.style.borderColor = '#e0e0e0')}
          />
        </div>

        <button
          data-testid="whiteboard-join-existing-btn"
          onClick={handleJoinRoom}
          disabled={joinCode.trim().length === 0}
          style={{
            display: 'block',
            width: '100%',
            padding: '14px 24px',
            border: 'none',
            borderRadius: 10,
            background: joinCode.trim().length > 0 ? '#3498db' : '#bdc3c7',
            color: '#fff',
            fontSize: 16,
            fontWeight: 600,
            cursor: joinCode.trim().length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Join Room
        </button>
      </div>
    </div>
  );
}

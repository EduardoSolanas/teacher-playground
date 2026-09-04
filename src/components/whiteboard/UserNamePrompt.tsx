import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';

const COLORS = [
  '#e74c3c',
  '#e67e22',
  '#f1c40f',
  '#2ecc71',
  '#3498db',
  '#9b59b6',
  '#1abc9c',
  '#e91e63',
  '#607d8b',
  '#ff6b6b',
];

function generateColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export default function UserNamePrompt({
  onJoin,
  roomId,
}: {
  onJoin: (name: string) => void;
  roomId: string;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [savedName] = useState(() => {
    try {
      return localStorage.getItem('whiteboard_username') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    if (savedName) {
      setName(savedName);
    }
  }, [savedName]);

  const handleJoin = (nextName = inputRef.current?.value ?? name) => {
    const trimmed = nextName.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem('whiteboard_username', trimmed);
      const color = generateColor(trimmed);
      localStorage.setItem('whiteboard_user_color', color);
    } catch {
      // localStorage unavailable
    }
    onJoin(trimmed);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleJoin();
  };

  return (
    <div className="modal-overlay">
      <form onSubmit={handleSubmit} className="modal-card">
        <h2 className="modal-title">Join room</h2>
        <p className="modal-text">Room: {roomId}</p>
        <label className="field-block">
          <span className="app-label">Your name</span>
          <input
            ref={inputRef}
            data-testid="whiteboard-username-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            autoFocus
            className="field-input"
          />
        </label>
        <button
          data-testid="whiteboard-join-room-btn"
          type="submit"
          disabled={!name.trim()}
          className="btn btn-block"
        >
          Join room
        </button>
      </form>
    </div>
  );
}

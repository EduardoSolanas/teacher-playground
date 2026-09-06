import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { generateUserColor, USER_COLOR_STORAGE_KEY } from '@/lib/whiteboard/userColor';

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
      localStorage.setItem(USER_COLOR_STORAGE_KEY, generateUserColor(trimmed));
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

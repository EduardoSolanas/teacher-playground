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
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 z-[1000]">
      <form onSubmit={handleSubmit} className="bg-white rounded-xl p-8 min-w-[320px] shadow-xl">
        <h2 className="m-0 mb-2 text-xl">Join Room</h2>
        <p className="m-0 mb-4 text-slate-500 text-sm">
          Room: {roomId}
        </p>
        <input
          ref={inputRef}
          data-testid="whiteboard-username-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your name"
          autoFocus
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm mb-4 box-border"
        />
        <button
          data-testid="whiteboard-join-room-btn"
          type="submit"
          disabled={!name.trim()}
          className="w-full px-0 py-2.5 rounded-lg border-none text-white text-sm font-semibold cursor-pointer transition-colors duration-150"
          style={{ background: name.trim() ? '#3498db' : '#ccc', cursor: name.trim() ? 'pointer' : 'not-allowed' }}
        >
          Join Room
        </button>
      </form>
    </div>
  );
}

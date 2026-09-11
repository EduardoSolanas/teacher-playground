import { useState, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { useDialogFocusTrap } from '../ConfirmDialog';
import { generateUserColor, USER_COLOR_STORAGE_KEY } from '@/lib/whiteboard/userColor';

export default function UserNamePrompt({
  onJoin,
}: {
  onJoin: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
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

  useDialogFocusTrap(dialogRef, inputRef);

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
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-name-prompt-title"
        className="modal-card"
      >
        <form onSubmit={handleSubmit}>
          <h2 id="user-name-prompt-title" className="modal-title">
            Ask to join
          </h2>
          <p className="modal-text">
            Your teacher will let you in.
          </p>
          <label className="field-block">
            <span className="app-label">Your name</span>
            <input
              ref={inputRef}
              data-testid="whiteboard-username-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="field-input"
            />
          </label>
          <button
            data-testid="whiteboard-join-room-btn"
            type="submit"
            disabled={!name.trim()}
            className="btn btn-block"
          >
            Ask to join
          </button>
        </form>
      </div>
    </div>
  );
}

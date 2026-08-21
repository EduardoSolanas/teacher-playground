import { useState, useCallback } from 'react';

export default function WaitingRoom({
  userName,
  roomCode,
  waitingPosition,
  onWait,
  onLeave,
}: {
  userName: string;
  roomCode: string;
  waitingPosition: number;
  onWait: () => void;
  onLeave: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onWait();
    setTimeout(() => setRefreshing(false), 800);
  }, [onWait]);

  return (
    <div className="session-screen fixed inset-0 z-[1000]">
      <div className="spinner-page waiting" />

      <h2 className="session-title">Room is Full</h2>
      <p className="session-text">{userName}, you are in the waiting queue</p>

      <div className="queue-card">
        <p className="queue-number">{waitingPosition}</p>
        <p className="queue-label">in line</p>
      </div>

      <div className="queue-card">
        <p className="queue-label">Room code</p>
        <p className="queue-code">{roomCode}</p>
      </div>

      <p className="status-line">
        <span className={`status-dot${refreshing ? ' busy' : ''}`} aria-hidden="true" />
        {refreshing ? 'Checking status…' : 'You are waiting for a spot'}
      </p>

      <p className="session-text session-note">
        The host will let you in when a spot opens up. Keep this tab open.
      </p>

      <div className="btn-row">
        <button onClick={handleRefresh} disabled={refreshing} className="btn-outline">
          {refreshing ? 'Checking…' : 'Refresh status'}
        </button>
        <button
          data-testid="whiteboard-leave-waiting-btn"
          onClick={onLeave}
          className="btn btn-small btn-danger"
        >
          Leave waiting room
        </button>
      </div>
    </div>
  );
}

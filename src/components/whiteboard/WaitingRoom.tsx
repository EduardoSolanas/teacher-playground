import { useState, useCallback } from 'react';

export default function WaitingRoom({
  userName,
  waitingPosition,
  onWait,
  onLeave,
  queueFull = false,
  suspended = false,
}: {
  userName: string;
  waitingPosition: number;
  onWait: () => void | Promise<void>;
  onLeave: () => void;
  queueFull?: boolean;
  suspended?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [checkedManually, setCheckedManually] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onWait();
    } finally {
      setRefreshing(false);
      setCheckedManually(true);
    }
  }, [onWait]);

  const notQueued = queueFull || suspended;
  const title = suspended
    ? 'Your teacher moved you back to the waiting room'
    : queueFull
      ? 'Waiting List is Full'
      : 'Room is Full';
  const subtitle = suspended
    ? `${userName}, you are back in the waiting room`
    : queueFull
      ? `${userName}, the waiting list is full`
      : `${userName}, you are in the waiting queue`;

  let statusText: string;
  if (refreshing) {
    statusText = 'Checking status…';
  } else if (suspended) {
    statusText = 'Your teacher moved you back to the waiting room';
  } else if (queueFull) {
    statusText = 'The waiting list is full — ask your teacher to let someone in or try again shortly';
  } else if (checkedManually) {
    statusText = `You are number ${waitingPosition} in line. Checked just now.`;
  } else {
    statusText = `You are number ${waitingPosition} in line. Checking automatically — last checked just now.`;
  }

  return (
    <div className="session-screen fixed inset-0 z-[1000]">
      <div className="spinner-page waiting" aria-hidden="true" />

      <h2 className="session-title">{title}</h2>
      <p className="session-text">{subtitle}</p>

      {!notQueued && (
        <div className="queue-card" aria-hidden="true">
          <p className="queue-number">{waitingPosition}</p>
          <p className="queue-label">in line</p>
        </div>
      )}

      <p className="status-line" role="status">
        <span className={`status-dot${refreshing ? ' busy' : ''}`} aria-hidden="true" />
        {statusText}
      </p>

      {!notQueued && (
        <p className="session-text session-note">
          The host will let you in when a spot opens up. Keep this tab open.
        </p>
      )}

      <div className="btn-row">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="link-aside mt-0 cursor-pointer bg-transparent px-0 disabled:cursor-wait disabled:opacity-60"
        >
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

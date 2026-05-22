import { useState, useEffect, useCallback } from 'react';

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
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-slate-50 z-[1000]">
      <div className="w-20 h-20 border-[4px] border-slate-200 border-t-amber-500 rounded-full mb-6"
        style={{ animation: 'wb-spin 0.8s linear infinite' }}
      />
      <style>{`
        @keyframes wb-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <h2 className="text-2xl font-bold text-slate-800 mb-2">Room is Full</h2>
      <p className="text-sm text-slate-500 mb-8">
        {userName}, you are in the waiting queue
      </p>

      <div className="bg-white rounded-2xl border border-slate-200 p-8 mb-8 text-center shadow-sm min-w-[280px]">
        <p className="text-5xl font-bold text-amber-500 mb-2">{waitingPosition}</p>
        <p className="text-xs text-slate-400 uppercase tracking-wider">in line</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6 text-center w-full max-w-sm">
        <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Room Code</p>
        <p className="text-lg font-mono font-semibold text-slate-700">{roomCode}</p>
      </div>

      <div className="flex items-center gap-2 mb-8">
        <div
          className={`w-4 h-4 rounded-full transition-colors ${
            refreshing ? 'bg-amber-400' : 'bg-emerald-400'
          }`}
        />
        <p className="text-sm text-slate-500">
          {refreshing ? 'Checking status...' : 'You are waiting for a spot'}
        </p>
      </div>

      <p className="text-sm text-slate-500 max-w-sm text-center mb-8">
        The host will let you in when a spot opens up. Keep this tab open.
      </p>

      <div className="flex gap-3">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-6 py-2.5 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium cursor-pointer hover:bg-slate-100 transition-colors disabled:opacity-50"
        >
          {refreshing ? 'Checking...' : 'Refresh status'}
        </button>
        <button
          data-testid="whiteboard-leave-waiting-btn"
          onClick={onLeave}
          className="px-6 py-2.5 rounded-lg bg-red-500 text-white text-sm font-medium cursor-pointer hover:bg-red-600 transition-colors"
        >
          Leave waiting room
        </button>
      </div>
    </div>
  );
}

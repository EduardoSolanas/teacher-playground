import type { WhiteboardUser } from '@/types/whiteboard';

export default function PresencePanel({
  users,
  localPeerId,
  collapsed,
  onToggle,
}: {
  users: WhiteboardUser[];
  localPeerId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const maxUsers = 3;

  return (
    <div
      className="fixed bottom-0 right-0 top-0 z-[100] flex flex-col overflow-hidden border-l border-slate-200 bg-white/95 shadow-xl shadow-slate-900/10 backdrop-blur transition-[width] duration-200"
      style={{ width: collapsed ? 40 : 220 }}
    >
      <button
        data-testid="whiteboard-presence-toggle"
        onClick={onToggle}
        className="flex h-10 cursor-pointer items-center justify-center border-b border-slate-200 bg-slate-50 text-[16px] text-slate-800 hover:bg-slate-100"
        title={collapsed ? 'Expand presence panel' : 'Collapse presence panel'}
      >
        {collapsed ? '>' : '<'}
      </button>

      {!collapsed && (
        <div className="border-b border-slate-200 px-3 py-2">
          <span className="text-xs text-slate-500">
            {users.length}/{maxUsers} users online
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {users.length === 0 ? (
          !collapsed && <p className="p-2 text-xs text-slate-400">No other users</p>
        ) : (
          users.map((user) => (
            <div
              key={user.peerId}
              data-testid={`whiteboard-user-${user.peerId}`}
              className="mb-1 flex items-center gap-2 rounded-lg p-2"
              style={{ background: user.peerId === localPeerId ? '#e8f4fd' : 'transparent' }}
            >
              <div
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: user.color }}
              >
                {user.userName.charAt(0).toUpperCase()}
              </div>
              {!collapsed && (
                <div className="min-w-0 overflow-hidden">
                  <div
                    className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-slate-900"
                    style={{ fontWeight: user.peerId === localPeerId ? 600 : 400 }}
                  >
                    {user.userName}
                    {user.peerId === localPeerId && (
                      <span className="text-xs font-normal text-slate-400"> (you)</span>
                    )}
                  </div>
                  {user.isHost && (
                    <span className="text-[10px] font-semibold text-emerald-500">Host</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

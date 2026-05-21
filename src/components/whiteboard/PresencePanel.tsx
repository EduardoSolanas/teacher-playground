import { useState, useCallback, useRef, useEffect } from 'react';
import type { WhiteboardUser } from '@/types/whiteboard';

interface PresencePanelProps {
  users: WhiteboardUser[];
  waitingPeers: WhiteboardUser[];
  localPeerId: string;
  collapsed: boolean;
  onToggle: () => void;
  onApprove: (peerId: string) => void;
  onReject: (peerId: string) => void;
}

export default function PresencePanel({
  users,
  waitingPeers,
  localPeerId,
  collapsed,
  onToggle,
  onApprove,
  onReject,
}: PresencePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPeerId, setMenuPeerId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((peerId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPeerId(peerId);
    setMenuOpen(true);
  }, []);

  const handleCloseMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuPeerId(null);
  }, []);

  useEffect(() => {
    if (menuOpen) {
      const handler = () => handleCloseMenu();
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [menuOpen, handleCloseMenu]);

  const handleApprove = useCallback(() => {
    if (menuPeerId) {
      onApprove(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onApprove, handleCloseMenu]);

  const handleReject = useCallback(() => {
    if (menuPeerId) {
      onReject(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onReject, handleCloseMenu]);

  const allUsers = [...waitingPeers, ...users];

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
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">
              {users.length}/{3} users online
            </span>
            {waitingPeers.length > 0 && (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
                {waitingPeers.length}
              </span>
            )}
          </div>
        </div>
      )}

      {collapsed && waitingPeers.length > 0 && (
        <div className="relative">
          <div className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-amber-500" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {allUsers.length === 0 ? (
          !collapsed && <p className="p-2 text-xs text-slate-400">No other users</p>
        ) : (
          allUsers.map((user) => {
            const isWaiting = user.isWaiting;
            const isMenuTarget = menuPeerId === user.peerId;

            return (
              <div
                key={user.peerId}
                data-testid={`whiteboard-user-${user.peerId}`}
                className={`mb-1 flex items-center gap-2 rounded-lg p-2 ${
                  isWaiting ? 'cursor-default' : ''
                }`}
                style={{
                  background: user.peerId === localPeerId ? '#e8f4fd' : isWaiting ? '#fef3c7' : 'transparent',
                }}
                onContextMenu={isWaiting ? (e) => handleContextMenu(user.peerId, e) : undefined}
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
                    {isWaiting && (
                      <span className="text-[10px] font-semibold text-amber-600">Waiting</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {menuOpen && menuPeerId && (
        <div
          ref={menuRef}
          className="fixed bg-slate-800 border border-slate-700 rounded-lg p-1 z-[10000] min-w-[160px] shadow-xl"
          style={{
            left: 'calc(100vw - 240px)',
            top: '50%',
          }}
        >
          <button
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-green-600 rounded"
            style={{ color: '#e5e7eb' }}
            onClick={handleApprove}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Accept
          </button>
          <button
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-red-600 rounded"
            style={{ color: '#e5e7eb' }}
            onClick={handleReject}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

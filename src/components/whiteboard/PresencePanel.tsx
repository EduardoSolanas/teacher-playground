import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { WhiteboardUser } from '@/types/whiteboard';

interface PresencePanelProps {
  users: WhiteboardUser[];
  waitingPeers: WhiteboardUser[];
  localPeerId: string;
  isLocalHost: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onApprove: (peerId: string) => void;
  onReject: (peerId: string) => void;
  onKick: (peerId: string) => void;
  onSuspend: (peerId: string) => void;
}

export default function PresencePanel({
  users,
  waitingPeers,
  localPeerId,
  isLocalHost,
  collapsed,
  onToggle,
  onApprove,
  onReject,
  onKick,
  onSuspend,
}: PresencePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPeerId, setMenuPeerId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [hoveredPeerId, setHoveredPeerId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleOpenMenu = useCallback((peerId: string, event?: React.MouseEvent) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const left = Math.max(8, Math.min((event?.clientX ?? window.innerWidth - 220) - 180, window.innerWidth - 196));
    const top = Math.max(48, Math.min((event?.clientY ?? window.innerHeight / 2) + 8, window.innerHeight - 150));
    setMenuPeerId(peerId);
    setMenuPosition({ left, top });
    setMenuOpen(true);
  }, []);

  const handleContextMenu = useCallback((peerId: string, e: React.MouseEvent) => {
    handleOpenMenu(peerId, e);
  }, [handleOpenMenu]);

  const handleCloseMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuPeerId(null);
  }, []);

  useEffect(() => {
    if (menuOpen) {
      const handler = (event: MouseEvent) => {
        if (menuRef.current?.contains(event.target as Node)) return;
        handleCloseMenu();
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }
  }, [menuOpen, handleCloseMenu]);

  const handleApproveAction = useCallback(() => {
    if (menuPeerId) {
      onApprove(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onApprove, handleCloseMenu]);

  const handleRejectAction = useCallback(() => {
    if (menuPeerId) {
      onReject(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onReject, handleCloseMenu]);

  const handleKick = useCallback(() => {
    if (menuPeerId) {
      onKick(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onKick, handleCloseMenu]);

  const handleSuspend = useCallback(() => {
    if (menuPeerId) {
      onSuspend(menuPeerId);
      handleCloseMenu();
    }
  }, [menuPeerId, onSuspend, handleCloseMenu]);

  const waitingPeerIds = new Set(waitingPeers.map((user) => user.peerId));
  const allUsers = [...waitingPeers, ...users.filter((user) => !waitingPeerIds.has(user.peerId))];
  const menuPeer = menuPeerId ? allUsers.find((user) => user.peerId === menuPeerId) : null;
  const menuPeerIsWaiting = Boolean(menuPeer?.isWaiting);
  const menu =
    isLocalHost && menuOpen && menuPeerId && menuPeer ? (
      <div
        ref={menuRef}
        className="fixed bg-slate-800 border border-slate-700 rounded-lg p-1 z-[10000] min-w-[180px] shadow-xl"
        style={{
          left: menuPosition.left,
          top: menuPosition.top,
        }}
      >
        {menuPeerIsWaiting ? (
          <>
            <button
              data-testid="whiteboard-context-let-in"
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-emerald-600 rounded"
              style={{ color: '#e5e7eb' }}
              onClick={handleApproveAction}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Let in
            </button>
            <button
              data-testid="whiteboard-context-reject"
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-red-600 rounded"
              style={{ color: '#e5e7eb' }}
              onClick={handleRejectAction}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Reject
            </button>
          </>
        ) : (
          <>
            <button
              data-testid="whiteboard-context-suspend"
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-amber-600 rounded"
              style={{ color: '#e5e7eb' }}
              onClick={handleSuspend}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              Send to Waiting Room
            </button>
            <button
              data-testid="whiteboard-context-kick"
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[13px] w-full text-left font-inherit transition-colors duration-150 hover:bg-red-600 rounded"
              style={{ color: '#e5e7eb' }}
              onClick={handleKick}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Kick from Room
            </button>
          </>
        )}
      </div>
    ) : null;

  return (
    <>
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
            const isSelf = user.peerId === localPeerId;
            const isHostUser = Boolean(user.isHost);
            const canModerate = isLocalHost && !isSelf && !isHostUser;

            const isWaitingModeratable = isWaiting && canModerate;

            return (
              <div
                key={user.peerId}
                data-testid={`whiteboard-user-${user.peerId}`}
                className={`mb-1 flex items-center gap-2 rounded-lg p-2 transition-colors duration-150 ${
                  canModerate ? 'cursor-pointer' : ''
                }`}
                style={{
                  background: isSelf ? '#e8f4fd' : isWaiting ? '#fef3c7' : hoveredPeerId === user.peerId ? '#ffedd5' : 'transparent',
                }}
                onClick={canModerate ? (e) => handleOpenMenu(user.peerId, e) : undefined}
                onContextMenu={canModerate ? (e) => handleContextMenu(user.peerId, e) : undefined}
                onMouseEnter={() => canModerate && setHoveredPeerId(user.peerId)}
                onMouseLeave={() => canModerate && setHoveredPeerId(null)}
              >
                <div
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ background: user.color }}
                >
                  {user.userName.charAt(0).toUpperCase()}
                </div>
                {!collapsed && (
                  <div
                    className="min-w-0 overflow-hidden flex-1"
                    style={{ cursor: canModerate ? 'pointer' : 'default' }}
                  >
                    <div
                      className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-slate-900"
                      style={{ fontWeight: isSelf ? 600 : 400 }}
                    >
                      {user.userName}
                      {isSelf && (
                        <span className="text-xs font-normal text-slate-400"> (you)</span>
                      )}
                    </div>
                    {isHostUser && (
                      <span className="text-[10px] font-semibold text-emerald-500">Host</span>
                    )}
                    {isWaiting && (
                      <span className="text-[10px] font-semibold text-amber-600">Waiting</span>
                    )}
                  </div>
                )}
                {isWaitingModeratable && !collapsed && (
                  <div className="flex gap-1 items-center">
                    <button
                      data-testid={`whiteboard-approve-${user.peerId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onApprove(user.peerId);
                      }}
                      className="flex-shrink-0 rounded-lg bg-emerald-500 px-3 py-1.5 text-[12px] font-semibold text-white shadow-md transition-colors duration-150 hover:bg-emerald-600"
                    >
                      Let in
                    </button>
                    <button
                      data-testid={`whiteboard-user-options-${user.peerId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenMenu(user.peerId, e);
                      }}
                      className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-md bg-slate-700 text-[12px] text-slate-300 transition-colors duration-150 hover:bg-slate-600"
                      title="Options"
                    >
                      ...
                    </button>
                  </div>
                )}
                {canModerate && !isWaiting && !collapsed && (
                  <button
                    data-testid={`whiteboard-user-options-${user.peerId}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenMenu(user.peerId, e);
                    }}
                    className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-md bg-slate-700 text-[12px] text-slate-300 transition-colors duration-150 hover:bg-slate-600"
                    title="Options"
                  >
                    ...
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      </div>
      {typeof document !== 'undefined' && menu ? createPortal(menu, document.body) : null}
    </>
  );
}

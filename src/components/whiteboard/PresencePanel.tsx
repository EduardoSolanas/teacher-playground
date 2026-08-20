'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { WhiteboardUser } from '@/types/whiteboard';
import { RaisedHandIcon } from './RaisedHandCue';
import { DEFAULT_MAX_USERS } from '@/lib/plan/limits';

function accountNameDisc(accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  const hex = accountId.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 4) return null;
  return hex.slice(-4).toLowerCase();
}

interface PresencePanelProps {
  users: WhiteboardUser[];
  waitingPeers: WhiteboardUser[];
  localPeerId: string;
  isLocalHost: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onApprove: (peerId: string, accountId?: string | null) => void;
  onReject: (peerId: string, accountId?: string | null) => void;
  onKick: (peerId: string, accountId?: string | null) => void;
  onSuspend: (peerId: string, accountId?: string | null) => void;
  onRaiseHand?: (raised: boolean) => void;
  /** Peer ids whose microphone is currently muted in the voice session. */
  mutedPeerIds?: ReadonlySet<string>;
  /** Room capacity from settings; used for the "N of M" count. */
  maxUsers?: number;
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function KebabIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function UserAvatar({ user, ring }: { user: WhiteboardUser; ring?: boolean }) {
  return (
    <div
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${ring ? 'ring-2 ring-sky-400 ring-offset-1 ring-offset-white' : ''}`}
      style={{ background: user.color }}
    >
      {user.userName.charAt(0).toUpperCase()}
    </div>
  );
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
  onRaiseHand,
  mutedPeerIds,
  maxUsers = DEFAULT_MAX_USERS,
}: PresencePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPeerId, setMenuPeerId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
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

  const waitingPeerIds = new Set(waitingPeers.map((user) => user.peerId));
  const activeUsers = users.filter((user) => !waitingPeerIds.has(user.peerId));
  // Host first, then everyone else, preserving order otherwise.
  const orderedActive = [
    ...activeUsers.filter((user) => user.isHost),
    ...activeUsers.filter((user) => !user.isHost),
  ];
  const allUsers = [...waitingPeers, ...activeUsers];
  const duplicateNames = new Set<string>();
  if (isLocalHost) {
    const nameCounts = new Map<string, number>();
    for (const user of allUsers) {
      nameCounts.set(user.userName, (nameCounts.get(user.userName) ?? 0) + 1);
    }
    for (const [name, count] of nameCounts) {
      if (count > 1) duplicateNames.add(name);
    }
  }
  const menuPeer = menuPeerId ? allUsers.find((user) => user.peerId === menuPeerId) : null;

  const handleApproveAction = useCallback(() => {
    if (menuPeerId) {
      onApprove(menuPeerId, menuPeer?.accountId);
      handleCloseMenu();
    }
  }, [menuPeerId, menuPeer?.accountId, onApprove, handleCloseMenu]);

  const handleRejectAction = useCallback(() => {
    if (menuPeerId) {
      onReject(menuPeerId, menuPeer?.accountId);
      handleCloseMenu();
    }
  }, [menuPeerId, menuPeer?.accountId, onReject, handleCloseMenu]);

  const handleKick = useCallback(() => {
    if (menuPeerId) {
      onKick(menuPeerId, menuPeer?.accountId);
      handleCloseMenu();
    }
  }, [menuPeerId, menuPeer?.accountId, onKick, handleCloseMenu]);

  const handleSuspend = useCallback(() => {
    if (menuPeerId) {
      onSuspend(menuPeerId, menuPeer?.accountId);
      handleCloseMenu();
    }
  }, [menuPeerId, menuPeer?.accountId, onSuspend, handleCloseMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCloseMenu();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, handleCloseMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const testId = target?.closest?.('[data-testid]')?.getAttribute('data-testid');
      if (testId === 'whiteboard-context-kick') {
        event.preventDefault();
        event.stopPropagation();
        handleKick();
        return;
      }
      if (testId === 'whiteboard-context-suspend') {
        event.preventDefault();
        event.stopPropagation();
        handleSuspend();
        return;
      }
      if (testId === 'whiteboard-context-let-in') {
        event.preventDefault();
        event.stopPropagation();
        handleApproveAction();
        return;
      }
      if (testId === 'whiteboard-context-reject') {
        event.preventDefault();
        event.stopPropagation();
        handleRejectAction();
        return;
      }
      if (menuRef.current?.contains(event.target as Node)) return;
      handleCloseMenu();
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [
    menuOpen,
    handleKick,
    handleSuspend,
    handleApproveAction,
    handleRejectAction,
    handleCloseMenu,
  ]);

  const menuPeerIsWaiting = Boolean(menuPeer?.isWaiting);
  const menu =
    isLocalHost && menuOpen && menuPeerId && menuPeer ? (
      <div
        ref={menuRef}
        className="fixed z-[1250] bg-slate-800 border border-slate-700 rounded-lg p-1 min-w-[180px] shadow-xl shadow-slate-950/30 pointer-events-auto"
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
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleApproveAction();
              }}
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
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleRejectAction();
              }}
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
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleSuspend();
              }}
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
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleKick();
              }}
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

  if (collapsed) {
    const stack = orderedActive.slice(0, 3);
    const overflow = Math.max(0, orderedActive.length - stack.length);
    const waitingCount = waitingPeers.length;
    const anyHandRaised = orderedActive.some((user) => user.handRaised);
    return (
      <>
        <button
          type="button"
          data-testid="whiteboard-presence-toggle"
          aria-expanded={false}
          onClick={onToggle}
          title="Show participants"
          className="presence-handle fixed right-2 top-[max(0.5rem,env(safe-area-inset-top))] z-[1200] flex w-11 cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/95 py-2 shadow-lg shadow-slate-950/30 backdrop-blur-md transition-colors duration-150 hover:bg-slate-800"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180 text-slate-200" />
          {stack.length > 0 ? (
            <div className="flex -space-x-1.5">
              {stack.map((user) => (
                <div
                  key={user.peerId}
                  className="h-5 w-5 flex-shrink-0 overflow-hidden rounded-full ring-2 ring-slate-900"
                  title={user.userName}
                >
                  <UserAvatar user={user} />
                </div>
              ))}
            </div>
          ) : (
            <UsersIcon className="h-5 w-5 text-slate-300" />
          )}
          {overflow > 0 && (
            <span className="text-[10px] font-semibold text-slate-300">+{overflow}</span>
          )}
          {waitingCount > 0 && (
            <span
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white"
              title={`${waitingCount} waiting`}
            >
              {waitingCount}
            </span>
          )}
          {anyHandRaised && (
            <RaisedHandIcon className="h-4 w-4" tone="ink" />
          )}
        </button>
        {menu}
      </>
    );
  }

  const localUser = activeUsers.find((user) => user.peerId === localPeerId);
  const canRaiseHand = Boolean(
    onRaiseHand && activeUsers.some((user) => user.peerId === localPeerId && !user.isWaiting),
  );

  return (
    <>
      <div
        className="presence-panel fixed z-[1200] flex w-full flex-col overflow-hidden rounded-t-2xl border-t border-slate-200 bg-white/95 shadow-xl shadow-slate-900/10 backdrop-blur bottom-0 inset-x-0 max-h-[62dvh] sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-0 sm:max-h-none sm:w-[min(220px,85vw)] sm:rounded-none sm:border-l sm:border-t-0"
        data-testid="whiteboard-presence-panel"
        aria-label="Participants"
      >
        {/* Mobile sheet grabber; desktop rail has no grabber. */}
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <div className="h-1.5 w-9 rounded-full bg-slate-300" />
        </div>

        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              In the room
            </span>
            <span data-testid="whiteboard-presence-count" className="text-[11px] font-medium text-slate-400">
              {activeUsers.length} of {maxUsers}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {waitingPeers.length > 0 && (
              <span className="flex h-5 items-center rounded-full bg-amber-100 px-2 text-[11px] font-semibold text-amber-700" title={`${waitingPeers.length} waiting`}>
                {waitingPeers.length} waiting
              </span>
            )}
            {canRaiseHand && (
              <button
                type="button"
                data-testid="whiteboard-raise-hand"
                className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-100"
                onClick={() => onRaiseHand?.(!localUser?.handRaised)}
              >
                {localUser?.handRaised ? 'Lower hand' : 'Raise hand'}
              </button>
            )}
            <button
              type="button"
              data-testid="whiteboard-presence-toggle"
              aria-expanded={true}
              onClick={onToggle}
              title="Hide participants"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-600"
            >
              <ChevronRightIcon className="hidden h-4 w-4 sm:block" />
              <ChevronDownIcon className="h-4 w-4 sm:hidden" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {orderedActive.length === 0 ? (
            <p className="p-2 text-xs text-slate-400">No one else here yet</p>
          ) : (
            orderedActive.map((user) => {
              const isSelf = user.peerId === localPeerId;
              const isHostUser = Boolean(user.isHost);
              const canModerate = isLocalHost && !isSelf && !isHostUser;
              const nameDisc =
                isLocalHost && duplicateNames.has(user.userName)
                  ? accountNameDisc(user.accountId)
                  : null;

              return (
                <div
                  key={user.peerId}
                  data-testid={`whiteboard-user-${user.peerId}`}
                  className={`mb-1 flex flex-wrap items-center gap-2 rounded-lg p-2 transition-colors duration-150 ${canModerate ? 'cursor-pointer' : ''} ${isSelf ? 'bg-sky-50' : canModerate ? 'hover:bg-orange-50' : ''}`}
                  onClick={canModerate ? (e) => handleOpenMenu(user.peerId, e) : undefined}
                  onContextMenu={canModerate ? (e) => handleContextMenu(user.peerId, e) : undefined}
                >
                  <UserAvatar user={user} ring={isSelf} />
                  <div
                    className="min-w-0 overflow-hidden flex-1"
                    style={{ cursor: canModerate ? 'pointer' : 'default' }}
                  >
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span
                        className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-slate-900"
                        style={{ fontWeight: isSelf ? 600 : 400 }}
                      >
                        {user.userName}
                      </span>
                      {isHostUser && (
                        <span
                          data-testid={`whiteboard-user-host-${user.peerId}`}
                          className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-600"
                        >
                          Host
                        </span>
                      )}
                      {nameDisc ? (
                        <span
                          data-testid={`whiteboard-user-disc-${user.peerId}`}
                          className="flex-shrink-0 text-[11px] font-mono font-normal text-slate-500"
                        >
                          {nameDisc}
                        </span>
                      ) : null}
                      {isSelf && (
                        <span className="flex-shrink-0 text-xs font-normal text-slate-400">(you)</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {user.handRaised && (
                        <span
                          data-testid={`whiteboard-user-hand-${user.peerId}`}
                          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600"
                        >
                          <RaisedHandIcon className="h-3.5 w-3.5" tone="ink" />
                          Hand raised
                        </span>
                      )}
                      {mutedPeerIds?.has(user.peerId) && (
                        <span
                          data-testid={`whiteboard-user-muted-${user.peerId}`}
                          className="text-[10px] font-semibold uppercase tracking-wide text-amber-600"
                        >
                          Muted
                        </span>
                      )}
                    </div>
                  </div>
                  {canModerate && (
                    <button
                      data-testid={`whiteboard-user-options-${user.peerId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenMenu(user.peerId, e);
                      }}
                      className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md bg-slate-700 text-slate-300 transition-colors duration-150 hover:bg-slate-600"
                      title="Options"
                    >
                      <KebabIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })
          )}

          {waitingPeers.length > 0 && (
            <div data-testid="whiteboard-waiting-section" className="mt-2 border-t border-slate-200 pt-2">
              <div className="flex items-center gap-1.5 px-2 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600">
                  Waiting
                </span>
                <span className="text-[11px] font-medium text-amber-500">{waitingPeers.length}</span>
              </div>
              {waitingPeers.map((user) => {
                const canModerate = isLocalHost;
                const nameDisc =
                  isLocalHost && duplicateNames.has(user.userName)
                    ? accountNameDisc(user.accountId)
                    : null;

                return (
                  <div
                    key={user.peerId}
                    data-testid={`whiteboard-user-${user.peerId}`}
                    className={`mb-1 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 transition-colors duration-150 ${canModerate ? 'cursor-pointer' : ''}`}
                    onClick={canModerate ? (e) => handleOpenMenu(user.peerId, e) : undefined}
                    onContextMenu={canModerate ? (e) => handleContextMenu(user.peerId, e) : undefined}
                  >
                    <UserAvatar user={user} />
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <div className="flex items-center gap-1.5 overflow-hidden">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-slate-900">
                          {user.userName}
                        </span>
                        {nameDisc ? (
                          <span
                            data-testid={`whiteboard-user-disc-${user.peerId}`}
                            className="flex-shrink-0 text-[11px] font-mono font-normal text-slate-500"
                          >
                            {nameDisc}
                          </span>
                        ) : null}
                        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                          Waiting
                        </span>
                      </div>
                    </div>
                    {canModerate && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          data-testid={`whiteboard-approve-${user.peerId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onApprove(user.peerId, user.accountId);
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
                          className="flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md bg-slate-700 text-slate-300 transition-colors duration-150 hover:bg-slate-600"
                          title="Options"
                        >
                          <KebabIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {menu}
    </>
  );
}

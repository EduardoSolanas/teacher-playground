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
  /** Peer ids currently speaking in the voice session. */
  speakingPeerIds?: ReadonlySet<string>;
  /** A/V participant state keyed by whiteboard peer id. */
  avPeerStates?: ReadonlyMap<
    string,
    { micMuted: boolean; micPresent: boolean; camOn: boolean; quality?: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown' }
  >;
  /** Owner-only row controls for muting remote published tracks. */
  onMutePeer?: (peerId: string, kind: 'audio' | 'video') => void;
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

function MicIcon({ className }: { className?: string }) {
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
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicOffIcon({ className }: { className?: string }) {
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
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function MicSpeakingIcon({ className }: { className?: string }) {
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
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
      <path d="M21 12c0 1.66-.67 3.26-1.88 4.44" />
      <path d="M3 12c0-1.66.67-3.26 1.88-4.44" />
    </svg>
  );
}

function CameraIcon({ className }: { className?: string }) {
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
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function CameraOffIcon({ className }: { className?: string }) {
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
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function UserAvatar({ user, ring }: { user: WhiteboardUser; ring?: boolean }) {
  return (
    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${ring ? 'ring-2 ring-sky-400 ring-offset-1 ring-offset-white' : ''}`}
        style={{ background: user.color }}
      >
        {user.userName.charAt(0).toUpperCase()}
      </div>
    </div>
  );
}

function showConnectionIssue(
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown' | undefined,
): quality is 'poor' | 'lost' {
  return quality === 'poor' || quality === 'lost';
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
  speakingPeerIds,
  avPeerStates,
  onMutePeer,
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
        className="fixed z-[1250] bg-slate-800 border border-slate-700 rounded-lg p-1 min-w-[11.25rem] shadow-xl shadow-slate-950/30 pointer-events-auto"
        style={{
          left: menuPosition.left,
          top: menuPosition.top,
        }}
      >
        {menuPeerIsWaiting ? (
          <>
            <button
              data-testid="whiteboard-context-let-in"
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[0.8125rem] text-slate-200 w-full text-left font-inherit transition-colors duration-150 hover:bg-emerald-600 rounded"
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
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[0.8125rem] text-slate-200 w-full text-left font-inherit transition-colors duration-150 hover:bg-red-600 rounded"
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
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[0.8125rem] text-slate-200 w-full text-left font-inherit transition-colors duration-150 hover:bg-amber-600 rounded"
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
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[0.8125rem] text-slate-200 w-full text-left font-inherit transition-colors duration-150 hover:bg-red-600 rounded"
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
    const waitingCount = waitingPeers.length;
    const anyHandRaised = orderedActive.some((user) => user.handRaised);
    const ariaLabel = `Participants: ${orderedActive.length} of ${maxUsers}${waitingCount > 0 ? `, ${waitingCount} waiting` : ''}`;
    return (
      <>
        <button
          type="button"
          data-testid="whiteboard-presence-toggle"
          aria-expanded={false}
          aria-controls="whiteboard-presence-panel"
          aria-label={ariaLabel}
          onClick={onToggle}
          title="Show participants"
          className="presence-handle fixed right-2 top-1/2 -translate-y-1/2 z-[1200] flex w-11 cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-900/95 py-2 shadow-lg shadow-slate-950/30 backdrop-blur-md transition-colors duration-150 hover:bg-slate-800"
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
          <span data-testid="whiteboard-presence-count" className="text-[0.625rem] font-semibold text-slate-300">
            {orderedActive.length}/{maxUsers}
          </span>
          {waitingCount > 0 && (
            <span
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[0.625rem] font-bold text-white"
              title={`${waitingCount} waiting`}
            >
              {waitingCount}
            </span>
          )}
          {anyHandRaised && (
            <RaisedHandIcon className="h-4 w-4" tone="ink" />
          )}
        </button>
        {/*
          Mounted unconditionally and left empty while the queue is: a screen
          reader only announces a live region that was already in the document
          when its text changed. Rendering the region together with its first
          message loses that first message — which is the one that matters.
        */}
        <span
          data-testid="whiteboard-presence-waiting-live"
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {waitingCount > 0
            ? `${waitingCount} ${waitingCount === 1 ? 'person' : 'people'} waiting to be let in`
            : ''}
        </span>
        {menu}
      </>
    );
  }

  const localUser = activeUsers.find((user) => user.peerId === localPeerId);
  // Raise-hand is a student mechanic: the host moderates and is never in the
  // queue to speak, so no control is rendered for them.
  const canRaiseHand = Boolean(
    onRaiseHand &&
    !isLocalHost &&
    activeUsers.some((user) => user.peerId === localPeerId && !user.isWaiting),
  );

  return (
    <>
      <div
        id="whiteboard-presence-panel"
        className="presence-panel fixed z-[1200] flex w-full flex-col overflow-hidden rounded-t-2xl border-t border-slate-200 bg-white/95 shadow-xl shadow-slate-900/10 backdrop-blur bottom-0 inset-x-0 max-h-[62dvh] sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-[calc(3rem+env(safe-area-inset-top))] sm:max-h-none sm:w-[min(13.75rem,85vw)] sm:rounded-none sm:border-l sm:border-t-0"
        data-testid="whiteboard-presence-panel"
        aria-label="Participants"
      >
        {/* Mobile sheet grabber; desktop rail has no grabber. */}
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <div className="h-1.5 w-9 rounded-full bg-slate-300" />
        </div>

        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">
              In the room
            </span>
            <span data-testid="whiteboard-presence-count" className="text-[0.6875rem] font-medium text-slate-400">
              {activeUsers.length}/{maxUsers}
            </span>
          </div>
          {/*
            No waiting badge here. The Waiting section directly below already
            heads itself with the same count, and a second copy of it was what
            pushed this header over 220px and wrapped "IN THE ROOM" onto two
            lines. The collapsed handle keeps its badge — there the section is
            not visible.
          */}
          <div className="flex shrink-0 items-center gap-1.5">
            {canRaiseHand && (
              <button
                type="button"
                data-testid="whiteboard-raise-hand"
                className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[0.6875rem] font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-100"
                onClick={() => onRaiseHand?.(!localUser?.handRaised)}
              >
                {localUser?.handRaised ? 'Lower hand' : 'Raise hand'}
              </button>
            )}
            <button
              type="button"
              data-testid="whiteboard-presence-toggle"
              aria-expanded={true}
              aria-controls="whiteboard-presence-panel"
              onClick={onToggle}
              title="Hide participants"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-slate-400 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-600"
            >
              <ChevronRightIcon className="hidden h-4 w-4 sm:block" />
              <ChevronDownIcon className="h-4 w-4 sm:hidden" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 sm:max-h-[45%] sm:flex-none">
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
              const isSpeaking = Boolean(speakingPeerIds?.has(user.peerId));
              const avState = avPeerStates?.get(user.peerId);
              const canMuteAv = Boolean(avState && canModerate && onMutePeer);
              const showQualityIssue = showConnectionIssue(avState?.quality);

              return (
                <div
                  key={user.peerId}
                  data-testid={`whiteboard-user-${user.peerId}`}
                  className={`mb-1 flex flex-wrap items-center gap-2 rounded-lg p-2 transition-colors duration-150 ${canModerate ? 'cursor-pointer' : ''} ${isSelf ? 'bg-sky-50' : canModerate ? 'hover:bg-orange-50' : ''}`}
                  onClick={canModerate ? (e) => handleOpenMenu(user.peerId, e) : undefined}
                  onContextMenu={canModerate ? (e) => handleContextMenu(user.peerId, e) : undefined}
                >
                  <div className="relative">
                    <UserAvatar user={user} ring={isSelf} />
                    {isSpeaking ? (
                      <span
                        data-testid={`whiteboard-user-speaking-${user.peerId}`}
                        role="img"
                        aria-label={`${user.userName} is speaking`}
                        className="pointer-events-none absolute -inset-1 rounded-full border-2 border-emerald-400 shadow-[0_0_0_2px_rgba(255,255,255,0.85)] animate-pulse"
                      />
                    ) : null}
                  </div>
                  <div
                    className="min-w-0 overflow-hidden flex-1"
                    style={{ cursor: canModerate ? 'pointer' : 'default' }}
                  >
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span
                        className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] text-slate-900"
                        style={{ fontWeight: isSelf ? 600 : 400 }}
                      >
                        {user.userName}
                      </span>
                      {isHostUser && (
                        <span
                          data-testid={`whiteboard-user-host-${user.peerId}`}
                          className="flex-shrink-0 text-[0.625rem] font-semibold uppercase tracking-wide text-emerald-600"
                        >
                          Host
                        </span>
                      )}
                      {nameDisc ? (
                        <span
                          data-testid={`whiteboard-user-disc-${user.peerId}`}
                          className="flex-shrink-0 text-[0.6875rem] font-mono font-normal text-slate-500"
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
                          className="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-amber-600"
                        >
                          <RaisedHandIcon className="h-3.5 w-3.5" tone="ink" />
                          Hand raised
                        </span>
                      )}
                      {avState && (
                        <div
                          data-testid={`whiteboard-user-av-${user.peerId}`}
                          className="flex items-center gap-1.5"
                        >
                          {(() => {
                            // Precedence: no mic > speaking > muted > plain live
                            if (!avState.micPresent) {
                              return (
                                <div role="img" aria-label={`${user.userName} has no microphone`}>
                                  <MicOffIcon className="h-3.5 w-3.5 text-slate-500" />
                                </div>
                              );
                            }
                            if (isSpeaking) {
                              return (
                                <div role="img" aria-label={`${user.userName} is talking`}>
                                  <MicSpeakingIcon className="h-3.5 w-3.5 text-slate-500" />
                                </div>
                              );
                            }
                            if (avState.micMuted) {
                              return (
                                <div role="img" aria-label={`${user.userName} microphone is muted`}>
                                  <MicOffIcon className="h-3.5 w-3.5 text-slate-500" />
                                </div>
                              );
                            }
                            return (
                              <div role="img" aria-label={`${user.userName} microphone is live`}>
                                <MicIcon className="h-3.5 w-3.5 text-slate-500" />
                              </div>
                            );
                          })()}
                          {avState.camOn ? (
                            <div role="img" aria-label={`${user.userName} camera is on`}>
                              <CameraIcon className="h-3.5 w-3.5 text-slate-500" />
                            </div>
                          ) : (
                            <div role="img" aria-label={`${user.userName} camera is off`}>
                              <CameraOffIcon className="h-3.5 w-3.5 text-slate-500" />
                            </div>
                          )}
                        </div>
                      )}
                      {showQualityIssue && (
                        <span
                          data-testid={`whiteboard-user-connection-quality-${user.peerId}`}
                          role="img"
                          aria-label={`${user.userName} connection is ${avState.quality}`}
                          className="text-[0.625rem] font-semibold uppercase tracking-wide text-amber-700"
                        >
                          {avState.quality === 'lost' ? 'Connection lost' : 'Poor connection'}
                        </span>
                      )}
                    </div>
                  </div>
                  {canMuteAv && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`whiteboard-user-mute-audio-${user.peerId}`}
                        aria-label={`Mute ${user.userName} microphone`}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.6875rem] font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMutePeer?.(user.peerId, 'audio');
                        }}
                      >
                        Mute mic
                      </button>
                      <button
                        type="button"
                        data-testid={`whiteboard-user-mute-video-${user.peerId}`}
                        aria-label={`Mute ${user.userName} camera`}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.6875rem] font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMutePeer?.(user.peerId, 'video');
                        }}
                      >
                        Mute cam
                      </button>
                    </div>
                  )}
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
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-amber-600">
                  Waiting
                </span>
                <span className="text-[0.6875rem] font-medium text-amber-500">{waitingPeers.length}</span>
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
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] text-slate-900">
                          {user.userName}
                        </span>
                        {nameDisc ? (
                          <span
                            data-testid={`whiteboard-user-disc-${user.peerId}`}
                            className="flex-shrink-0 text-[0.6875rem] font-mono font-normal text-slate-500"
                          >
                            {nameDisc}
                          </span>
                        ) : null}
                        <span className="flex-shrink-0 text-[0.625rem] font-semibold uppercase tracking-wide text-amber-600">
                          Waiting
                        </span>
                      </div>
                    </div>
                    {canModerate && (
                      // basis-full: at 220px the name, Let in and the kebab
                      // cannot share a line — the name lost, ellipsising to a
                      // single letter. The controls wrap under it instead.
                      <div className="flex basis-full shrink-0 items-center justify-end gap-1">
                        <button
                          data-testid={`whiteboard-approve-${user.peerId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onApprove(user.peerId, user.accountId);
                          }}
                          className="flex-shrink-0 rounded-lg bg-emerald-500 px-3 py-1.5 text-[0.75rem] font-semibold text-white shadow-md transition-colors duration-150 hover:bg-emerald-600"
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

        {/*
          The roster is sized to its own content, so a room of one no longer
          stretches a single row down a 13.75rem column of white. What is left of
          the rail is this reserved region rather than the roster's overflow:
          tinted and ruled off so the space reads as part of the panel, and
          already the right shape for the chat that will mount into it.
        */}
        <div className="hidden flex-1 border-t border-slate-200 bg-slate-50/70 sm:block" aria-hidden="true" />
      </div>
      {menu}
    </>
  );
}

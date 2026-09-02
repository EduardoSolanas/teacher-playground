'use client';

import { useEffect, useRef, useState } from 'react';

import {
  RAISED_HAND_CUE_MS,
  newlyRaisedPeerIds,
  raisedPeerIds,
  type RaisedHandPresence,
} from '@/lib/whiteboard/raisedHandCue';

export function RaisedHandIcon({
  className,
  tone = 'glow',
}: {
  className?: string;
  tone?: 'glow' | 'ink';
}) {
  const outer = tone === 'glow' ? '#fde68a' : '#d97706';
  const inner = tone === 'glow' ? '#fffbeb' : '#fbbf24';
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <path
        d="M22 30V16.5a3.5 3.5 0 0 1 7 0V28M29 28V14.5a3.5 3.5 0 0 1 7 0V28M36 28V17.5a3.5 3.5 0 1 1 7 0V32c0 8.5-5.2 16-14.5 16S14 40.5 14 32v-6.5a3.5 3.5 0 0 1 7 0V30"
        stroke={outer}
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 30V16.5a3.5 3.5 0 0 1 7 0V28M29 28V14.5a3.5 3.5 0 0 1 7 0V28M36 28V17.5a3.5 3.5 0 1 1 7 0V32c0 8.5-5.2 16-14.5 16S14 40.5 14 32v-6.5a3.5 3.5 0 0 1 7 0V30"
        stroke={inner}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function RaisedHandCue({
  users,
  localPeerId,
  isLocalHost,
}: {
  users: readonly RaisedHandPresence[];
  localPeerId: string;
  isLocalHost: boolean;
}) {
  const [cue, setCue] = useState<{ name: string; key: number } | null>(null);
  const previous = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isLocalHost) {
      previous.current = new Set();
      setCue(null);
      return;
    }
    const added = newlyRaisedPeerIds(previous.current, users, localPeerId);
    previous.current = raisedPeerIds(users, localPeerId);
    if (added.length === 0) return;
    const peerId = added[added.length - 1];
    const name = users.find((user) => user.peerId === peerId)?.userName?.trim() || 'Someone';
    setCue({ name, key: Date.now() });
  }, [users, isLocalHost, localPeerId]);

  useEffect(() => {
    if (cue === null) return;
    const timer = window.setTimeout(() => setCue(null), RAISED_HAND_CUE_MS);
    return () => window.clearTimeout(timer);
  }, [cue]);

  if (!isLocalHost || cue === null) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[1300]"
      aria-live="polite"
    >
      <div
        key={cue.key}
        role="status"
        data-testid="whiteboard-raised-hand-cue"
        data-phasing="out"
        className="raised-hand-cue absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
        onAnimationEnd={() => setCue(null)}
      >
        <RaisedHandIcon className="raised-hand-cue-icon h-48 w-48 sm:h-64 sm:w-64" />
        <p className="mt-3 rounded-full bg-slate-900/75 px-5 py-1.5 text-base sm:text-lg font-semibold text-amber-100 shadow-xl backdrop-blur-sm">
          {cue.name}
        </p>
      </div>
    </div>
  );
}

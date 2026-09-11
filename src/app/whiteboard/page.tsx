'use client';

import { useEffect, useState } from 'react';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import { UserProfileMenu } from '@/components/whiteboard/UserProfileMenu';
import TeacherRoomsPanel from './TeacherRoomsPanel';

export default function WhiteboardRoute() {
  const [hostDisplayName, setHostDisplayName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sessionResponse = await ajaxFetch('/auth/session/current');
        if (cancelled || !sessionResponse.ok) return;
        const session: unknown = await sessionResponse.json();
        const displayName = session && typeof session === 'object'
          ? (session as { displayName?: unknown }).displayName
          : undefined;
        setHostDisplayName(typeof displayName === 'string' ? displayName : null);
      } catch {
        // The profile name is optional; the page works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-screen pt-[calc(3rem+env(safe-area-inset-top))]">
      <header
        data-testid="whiteboard-rooms-top-nav"
        className="fixed inset-x-0 top-0 z-[1100] flex h-[calc(3rem+env(safe-area-inset-top))] items-center justify-end border-b border-slate-700/80 bg-slate-900/95 pt-[env(safe-area-inset-top)] text-slate-200 shadow-lg shadow-slate-950/20 backdrop-blur-md"
      >
        <div className="flex h-full items-center pr-[max(0.5rem,env(safe-area-inset-right))]">
          <UserProfileMenu
            displayName={hostDisplayName}
            onDisplayNameChange={setHostDisplayName}
            showDisplayName={false}
            triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-400 hover:bg-slate-700 active:bg-slate-600"
          />
        </div>
      </header>

      <main className="app-main">
        <div className="paper-card">
          <h1 className="app-title">
            Collaborative Whiteboard
          </h1>
          <p className="app-sub">
            Create a room to start collaborating in real-time
          </p>

          <TeacherRoomsPanel />
        </div>
      </main>
    </div>
  );
}

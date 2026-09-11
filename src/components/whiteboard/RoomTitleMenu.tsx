'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';
import { guestHostJoinUrl } from '@/lib/whiteboard/guestJoinUrl';
import {
  formatGuestPin,
  guestPinState,
  readGuestSettings,
  teacherRoomTitle,
  type GuestSettings,
} from './TeacherRoomList';

/**
 * What the room is called, and the way into what can be done with it.
 *
 * The name was a label with a pencil beside it, which said "this one field can
 * be edited" and nothing about the rest. A room has more to it than its name --
 * taking a copy away, reaching the library -- and those were scattered: one in
 * a hamburger in the far corner of the canvas, one floating over the board.
 * They belong together, and the title is where somebody looks to find out what
 * room they are in.
 *
 * Everything behind it is the owner's, so somebody who may not manage the room
 * sees the name and no menu at all rather than a menu that refuses them.
 */
export default function RoomTitleMenu({
  name,
  roomId,
  canManage,
  onRename,
  onSaveAs,
  onOpenLibrary,
  request = ajaxFetch,
}: {
  readonly name: string | null;
  readonly roomId: string;
  readonly canManage: boolean;
  readonly onRename: (next: string) => void;
  readonly onSaveAs: () => void;
  readonly onOpenLibrary: () => void;
  /** Injected so tests can drive the share panel with real responses. */
  readonly request?: AjaxFetch;
}) {
  const title = teacherRoomTitle({ roomId: '', name });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [draft, setDraft] = useState(title);
  /*
   * `undefined` is "still reading", `null` is "the read failed". Neither is
   * the same as guest access being off, and saying "off" before the answer is
   * known would offer to create a PIN for a room that already has one.
   */
  const [shareSettings, setShareSettings] = useState<GuestSettings | null | undefined>(undefined);
  const [shareReadAt, setShareReadAt] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const shareRef = useRef<HTMLDivElement>(null);
  const showMenuItems = !editing && !sharing;

  /*
   * Follow a rename from anywhere else -- the room list, another tab -- but
   * never while the box is open, or a poll landing mid-edit would take the
   * words out from under the person typing them.
   */
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /*
   * The WAI-ARIA menu pattern: focus enters with the menu, arrows and
   * Home/End walk it, Escape closes it and hands focus back to the trigger.
   * Without this the roles promised keyboard behaviour the component did not
   * have -- Tab skipped the whole menu and Escape dropped focus on the body.
   */
  useEffect(() => {
    if (!open) return;
    if (sharing) {
      // The menu items are gone; keep the keyboard inside the panel that
      // replaced them rather than dropping focus on the body.
      shareRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
      return;
    }
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, sharing]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setSharing(false);
      triggerRef.current?.focus();
      return;
    }
    // While the share panel is showing there are no menu items to walk; its
    // own buttons keep their ordinary tab order.
    if (!showMenuItems) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      // A menu is not a form: Tab leaves it rather than walking its items.
      setOpen(false);
      setSharing(false);
    }
  };

  /*
   * The same settings source the room list uses, so the PIN shown beside the
   * board is the PIN students will be asked for -- not a second read with its
   * own rules.
   */
  const loadShareSettings = useCallback(() => {
    setShareSettings(undefined);
    void readGuestSettings(request, roomId).then((settings) => {
      // Stamp the read so rendering the PIN never calls Date.now() (render
      // must stay pure); the read happens when the share panel opens.
      setShareReadAt(Date.now());
      setShareSettings(settings);
    });
  }, [request, roomId]);

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // The link is printed beside the button, so a refused clipboard still
      // leaves it selectable by hand.
    }
  };

  const commit = () => {
    const next = draft.trim();
    /*
     * roomSettingsSchema takes a non-empty string or nothing at all, so a
     * blank save would 400 and be swallowed by the caller: an edit that looks
     * committed and changed nothing. Keep the box open instead.
     */
    if (!next) return;
    onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        data-testid="room-name-input"
        autoFocus
        value={draft}
        aria-label="Room name"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') {
            setDraft(title);
            setEditing(false);
          }
        }}
        onBlur={commit}
        className="w-full max-w-[16rem] rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-center text-[0.8125rem] font-medium text-slate-100"
      />
    );
  }

  const label = (
    <span data-testid="room-name" title={title} className="truncate">
      {title}
    </span>
  );

  if (!canManage) {
    return (
      <span className="min-w-0 truncate text-[0.8125rem] font-medium text-slate-200">{label}</span>
    );
  }

  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[0.8125rem] text-slate-200 transition-colors hover:bg-slate-700';
  const shareUrl = guestHostJoinUrl(roomId);
  const guestAccessOff = shareSettings !== undefined && shareSettings !== null && !shareSettings.guestAccess;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid="room-title-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            setSharing(false);
            return;
          }
          setSharing(false);
          setOpen(true);
        }}
        className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[0.8125rem] font-medium text-slate-200 transition-colors hover:bg-slate-700"
      >
        {label}
        {/* Without this the title is a word, and a word is not a control. */}
        <svg
          data-testid="room-title-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          role={showMenuItems ? 'menu' : undefined}
          data-testid="room-title-menu"
          onKeyDown={onMenuKeyDown}
          className="absolute left-1/2 top-full z-[1200] mt-1 w-48 -translate-x-1/2 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 py-1 shadow-xl shadow-slate-950/40"
        >
          {sharing ? (
            <div ref={shareRef} data-testid="room-title-share" className="px-3 py-2">
              <p className="m-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">
                Share this room
              </p>
              <p className="m-0 mt-1 text-[0.75rem] leading-relaxed text-slate-400">
                Students open the link and enter the class PIN.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span
                  data-testid="room-share-url"
                  title={shareUrl}
                  className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-slate-300"
                >
                  {shareUrl}
                </span>
                <button
                  type="button"
                  data-testid="room-share-copy"
                  disabled={guestAccessOff}
                  aria-label={shareCopied ? 'Join link copied' : 'Copy join link'}
                  title={shareCopied ? 'Copied' : 'Copy join link'}
                  onClick={() => { void copyShareUrl(); }}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-600 bg-slate-800 text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {shareCopied ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m20 6-11 11-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                    </svg>
                  )}
                </button>
              </div>
              {guestAccessOff && (
                <p className="m-0 mt-1 text-[0.75rem] text-amber-300">
                  Create a PIN to let students use this link.
                </p>
              )}
              <p className="m-0 mt-2.5 flex items-center gap-2 text-[0.8125rem]">
                <span className="text-slate-400">Class PIN</span>
                {shareSettings === undefined ? (
                  <span data-testid="room-share-pin-checking" className="text-slate-400">
                    Checking…
                  </span>
                ) : shareSettings === null ? (
                  <span data-testid="room-share-pin-error" className="text-amber-300">
                    Couldn’t check the class PIN.{' '}
                    <button
                      type="button"
                      data-testid="room-share-retry"
                      onClick={loadShareSettings}
                      className="underline"
                    >
                      Retry
                    </button>
                  </span>
                ) : guestPinState(shareSettings, shareReadAt) === 'live' && shareSettings.guestPin ? (
                  <span data-testid="room-share-pin" className="font-semibold">
                    {formatGuestPin(shareSettings.guestPin)}
                  </span>
                ) : (
                  <span data-testid="room-share-pin-off" className="text-slate-400">
                    {guestPinState(shareSettings, shareReadAt) === 'expired'
                      ? 'Expired'
                      : 'Not switched on'}
                  </span>
                )}
              </p>
              <button
                type="button"
                data-testid="room-share-back"
                onClick={() => setSharing(false)}
                className="mt-2 w-full rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-slate-300 transition-colors hover:bg-slate-700"
              >
                Back
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                data-testid="room-menu-share"
                className={item}
                onClick={() => {
                  setShareCopied(false);
                  setSharing(true);
                  loadShareSettings();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5 shrink-0">
                  <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                  <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                </svg>
                Share join link / class PIN
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="room-menu-save"
                className={item}
                onClick={() => {
                  setOpen(false);
                  onSaveAs();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5 shrink-0">
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M5 21h14" />
                </svg>
                Save as…
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="room-menu-rename"
                className={item}
                onClick={() => {
                  setOpen(false);
                  setDraft(title);
                  setEditing(true);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5 shrink-0">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="room-menu-library"
                className={item}
                onClick={() => {
                  setOpen(false);
                  onOpenLibrary();
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5 shrink-0">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                </svg>
                Manage library
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

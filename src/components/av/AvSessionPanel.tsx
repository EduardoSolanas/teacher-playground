'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '../ConfirmDialog';
import { CALL_RAIL_WIDTH } from '@/lib/av/callRail';
import { RoomContext, RoomAudioRenderer, VideoTrack, useAudioPlayback } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import { Track } from 'livekit-client';

import CallControls from './CallControls';
import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { AvSessionStatus, AvDevice, ParticipantState } from '@/lib/av/avSession';
import { contrastTextOn } from '@/lib/whiteboard/userColor';

export type AvPanelMode = 'rail' | 'focus' | 'off';

export interface AvUser {
  readonly peerId: string;
  readonly userName: string;
  readonly accountId?: string | null;
  readonly color?: string;
  readonly isHost?: boolean;
  readonly handRaised?: boolean;
}

interface AvSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  /** Users in the room to resolve human names and hand raised state. */
  readonly users?: readonly AvUser[];
  /** Start out of the way rather than open. */
  readonly collapsed?: boolean;
  /**
   * Told whenever the rail appears or goes away, including on first render.
   *
   * The board ends where the rail starts, so the room has to reserve that width
   * -- and give it back the moment the rail is hidden.
   */
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Hang up for this person only, without leaving the room.
   *
   * The board carries on either way, so this is not the Leave in the bottom
   * bar. Absent where the call is not something the caller can leave.
   */
  readonly onLeaveCall?: () => void;
  /**
   * End the room's call for everybody in it. Host only: pass it only for a
   * host, and a peer gets no such control. Leaving and ending are deliberately
   * separate, so a teacher who steps away does not hang up on the class --
   * which is the choice Pencil Spaces and Google Meet both give a host.
   */
  readonly onEndCallForEveryone?: () => void;
}

function errorCopy(av: UseAvSessionResult): string | null {
  if (av.unavailableReason === 'unconfigured') {
    return 'Video calling is not configured on this server.';
  }
  /*
   * 'waiting' and 'forbidden' are not rendered here. The panel only mounts for
   * an admitted participant with the call switched on, so those two states are
   * unreachable from this surface -- the waiting room and the join gates own
   * their own copy, and a branch here would be dead words pretending to be a
   * fallback.
   */
  if (!av.error) return null;
  if (av.error.kind === 'permission-denied') {
    return 'Camera or microphone permission was denied.';
  }
  if (av.error.kind === 'device-busy') {
    return 'That camera or microphone is in use by another app. Close the other app and try again.';
  }
  if (av.error.kind === 'device-missing') {
    /*
     * Name the one that is actually missing.
     *
     * "No camera or microphone was found" over a working microphone reads as
     * the whole call being broken, and the commonest case by far is a desktop
     * that has simply never had a webcam. The enumerated lists already know
     * which it is, so there is no need to guess.
     */
    const noCamera = av.devices.camera.length === 0;
    const noMicrophone = av.devices.microphone.length === 0;
    if (noCamera && !noMicrophone) return 'No camera was found. The call carries on with audio.';
    if (noMicrophone && !noCamera) return 'No microphone was found.';
    return 'No camera or microphone was found.';
  }
  if (av.error.kind === 'network') {
    return 'Could not connect to the video room.';
  }
  return av.error.message;
}

/**
 * What to call a device in the menu.
 *
 * The browser withholds the label until it has a permission to show it by, so
 * a numbered fallback has to stand in -- "Microphone 2" is still something a
 * person can choose between, and the bare id never was.
 */
function deviceLabel(device: AvDevice, index: number, kind: 'Microphone' | 'Camera' | 'Speaker'): string {
  return device.label.trim() || `${kind} ${index + 1}`;
}

/**
 * Select a device value for a controlled select element, falling back to the
 * placeholder when the active device is not among the enumerated options.
 *
 * LiveKit seeds its active-device map from its own capture defaults, which are
 * the literal string 'default'. Browsers expose 'default' only for audioinput
 * and audiooutput (not videoinput), and typically only on Chrome/Edge. When the
 * call is denied a camera, no track publishes to replace the stale 'default'
 * string with the real device id, so that 'default' gets reported as active
 * even though it is not in the enumerated devices. A controlled <select> whose
 * value matches no <option> renders blank instead of showing the placeholder
 * -- a row that looks broken rather than one that looks unset.
 */
function selectedDeviceValue(devices: readonly AvDevice[], activeId: string | undefined): string {
  if (!activeId) return '';
  return devices.some((device) => device.deviceId === activeId) ? activeId : '';
}

/*
 * Icons, inline SVG only -- DESIGN.md §8: no emoji as UI icons. They are
 * currentColor strokes so the button's own colour drives them, and aria-hidden
 * because every one sits inside a control that already carries a name.
 */
function IconSpeaker({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5L6 9H3v6h3l5 4V5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />
    </svg>
  );
}

function IconHand({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V6.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V11m0-1a1.5 1.5 0 013 0v5a5 5 0 01-5 5h-1.5a5.5 5.5 0 01-5.5-5.5V12a1.5 1.5 0 013 0v1" />
    </svg>
  );
}

function IconScreen({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18v11H3V5zM9 20h6m-3-4v4" />
    </svg>
  );
}

function IconCrown({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-1.5 10h-15L3 8z" />
    </svg>
  );
}

function IconPictureInPicture({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18v14H3V5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 11h6v5h-6v-5z" />
    </svg>
  );
}

function IconFullscreen({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </svg>
  );
}

/**
 * What, if anything, the panel can offer after a call stops working.
 *
 * A refusal is worth another try; a token that expired or a socket that closed
 * needs a fresh join. Both mean asking the server again. A deployment with no
 * LiveKit configured is not retryable -- the answer will be 503 again -- so it
 * gets the explanation and no button.
 *
 * Any `idle` status qualifies, whether or not the hook still holds a Room:
 * `onDisconnected` deliberately leaves the Room instance in place (only
 * `leave()` clears it), so keying this on the room being absent missed exactly
 * the token-expiry and socket-close states it existed for.
 */
function callRecoveryAction(
  status: AvSessionStatus,
  unavailableReason: UseAvSessionResult['unavailableReason'],
): 'retry' | 'rejoin' | null {
  if (unavailableReason === 'unconfigured') return null;
  if (status === 'error') return 'retry';
  if (status === 'idle') return 'rejoin';
  return null;
}

function modeButtonClass(active: boolean): string {
  return active
    ? 'rounded-lg bg-slate-800 px-3 py-1 text-[0.6875rem] font-semibold text-white shadow-sm border border-slate-700/80 transition-colors duration-150'
    : 'rounded-lg px-3 py-1 text-[0.6875rem] font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-colors duration-150';
}

/*
 * Plain-language layout names. "Rail" described where the thing sat; "Off"
 * read as ending the call, when the call carries on behind a hidden panel.
 */
const LAYOUT_OPTIONS: readonly { value: AvPanelMode; label: string }[] = [
  { value: 'rail', label: 'Gallery' },
  { value: 'focus', label: 'Focus' },
  { value: 'off', label: 'Hidden' },
];

function AudioPlaybackBanner({ room }: { readonly room: Room }) {
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  if (canPlayAudio) return null;
  return (
    <button
      type="button"
      data-testid="av-audio-unlock"
      onClick={() => void startAudio()}
      className="mb-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-center text-[0.6875rem] font-semibold text-amber-200 shadow-sm transition-colors duration-150 hover:bg-amber-500/30"
    >
      <IconSpeaker className="h-3.5 w-3.5 shrink-0" /> Audio blocked by browser. Click to enable sound.
    </button>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getFirstInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase();
}

export function resolveParticipantInfo(
  participantIdentity: string,
  localIdentity: string,
  isLocal: boolean,
  users?: readonly AvUser[],
): {
  displayName: string;
  initials: string;
  handRaised: boolean;
  color: string | null;
  isHost: boolean;
} {
  const isMe = isLocal || participantIdentity === localIdentity || participantIdentity === '__local__';
  const user = users?.find(
    (u) =>
      u.peerId === participantIdentity ||
      (isMe && u.peerId === localIdentity) ||
      (u.accountId && (
        u.accountId === participantIdentity ||
        (isMe && u.accountId === localIdentity)
      )),
  );

  const handRaised = Boolean(user?.handRaised);
  const color = user?.color ?? null;
  const isHost = Boolean(user?.isHost);

  if (isMe) {
    const name = user?.userName ? `${user.userName} (you)` : 'You';
    const initials = user?.userName ? getInitials(user.userName) : 'YO';
    return { displayName: name, initials, handRaised, color, isHost };
  }

  if (user?.userName) {
    return { displayName: user.userName, initials: getInitials(user.userName), handRaised, color, isHost };
  }

  return {
    displayName: participantIdentity,
    initials: participantIdentity.slice(0, 2).toUpperCase(),
    handRaised,
    color,
    isHost,
  };
}

function ParticipantTile({
  participant,
  isLocal,
  av,
  localIdentity,
  users,
  onFocus,
  pinned = false,
}: {
  participant: ParticipantState;
  isLocal: boolean;
  av: UseAvSessionResult;
  localIdentity: string;
  users?: readonly AvUser[];
  onFocus?: (() => void) | null;
  pinned?: boolean;
}) {
  const tileRef = useRef<HTMLDivElement>(null);

  /*
   * Fullscreen the tile rather than the video inside it.
   *
   * The name and the mute state are drawn over the video as siblings, so
   * fullscreening the `<video>` alone would drop them -- and a full screen of
   * face with no name on it is the one moment you most want the name.
   *
   * Both halves of the API are optional. jsdom has neither, and nor does a
   * frame that was denied the permission; a control that throws there is worse
   * than one that quietly does nothing.
   */
  const toggleFullscreen = () => {
    const tile = tileRef.current;
    if (!tile) return;
    if (document.fullscreenElement === tile) {
      const exit = document.exitFullscreen?.bind(document);
      if (exit) void exit().catch(() => undefined);
      return;
    }
    const request = tile.requestFullscreen?.bind(tile);
    if (!request) return;
    void request().catch(() => undefined);
  };

  const togglePictureInPicture = () => {
    const tile = tileRef.current;
    const video = tile?.querySelector('video');
    if (!video) return;
    if (document.pictureInPictureElement === video) {
      const exit = document.exitPictureInPicture?.bind(document);
      if (exit) void exit().catch(() => undefined);
      return;
    }
    const request = video.requestPictureInPicture?.bind(video);
    if (!request) return;
    void request().catch(() => undefined);
  };

  const participantObj = av.room
    ? isLocal || participant.identity === '__local__'
      ? av.room.localParticipant
      : av.room.remoteParticipants.get(participant.identity)
    : null;
  const screenPub = participantObj?.getTrackPublication(Track.Source.ScreenShare);
  const isScreenShareLive = Boolean(
    screenPub?.track && !screenPub.isMuted && (isLocal || screenPub.isSubscribed),
  );
  const cameraPub = participantObj?.getTrackPublication(Track.Source.Camera);


  const videoPublication = isScreenShareLive ? screenPub : cameraPub;
  const isScreenShare = isScreenShareLive && videoPublication?.source === Track.Source.ScreenShare;
  const trackRef = participantObj && videoPublication?.track
    ? { participant: participantObj, publication: videoPublication, source: videoPublication.source }
    : null;
  const shouldMirror = isLocal && !isScreenShare;

  const { displayName, handRaised, color, isHost } = resolveParticipantInfo(
    participant.identity,
    localIdentity,
    isLocal,
    users,
  );
  const firstInitial = getFirstInitial(displayName);

  return (
    <div
      ref={tileRef}
      data-testid={`av-tile-${participant.identity}`}
      className={`group relative aspect-video overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/80 shadow-md transition-colors duration-150 [&:fullscreen]:aspect-auto [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none [&:fullscreen_video]:object-contain ${
        participant.isSpeaking ? 'ring-2 ring-[var(--blue)] ring-offset-2 ring-offset-slate-900 shadow-lg' : ''
      }`}
    >
      {av.room && trackRef && (participant.camOn || isScreenShare) ? (
        <VideoTrack
          trackRef={trackRef}
          data-testid={`av-video-track-${participant.identity}`}
          className={`h-full w-full object-cover ${shouldMirror ? '-scale-x-100' : ''}`}
        />
      ) : null}
      {!participant.camOn && !isScreenShare && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-slate-950/90 p-2 pb-7 text-slate-300">
          <div
            data-testid={`av-avatar-${participant.identity}`}
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-slate-600/60 bg-slate-800/80 text-base font-semibold shadow-inner"
            /*
             * The ring is the person's own board colour; the letter picks the
             * ink that reads on it. White on the palette's yellow is 1.66:1,
             * so an unconditional white was unreadable for parts of the class.
             */
            style={{
              borderColor: color ?? undefined,
              color: color ? contrastTextOn(color) : undefined,
            }}
          >
            {firstInitial}
          </div>
          <span className="text-[0.6875rem] font-medium text-slate-400">
            Camera off
          </span>
        </div>
      )}
      {/*
        * One flow container, not four elements each pinned to the same corner.
        * The host badge is permanent while the other three come and go, so a
        * host raising their hand drew one badge on top of another. Wrapping
        * lets them sit side by side and wrap onto a second line on a narrow
        * tile. The quality badge still defers to hand-raised: both are
        * transient and hand-raised is the one being waited on.
        */}
      <div
        data-testid={`av-tile-badges-${participant.identity}`}
        className="absolute left-1.5 top-1.5 z-10 flex flex-wrap items-start gap-1"
      >
        {handRaised && (
          <div
            data-testid={`av-hand-raised-${participant.identity}`}
            className="flex items-center gap-1 rounded-md bg-amber-500/90 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-slate-950 shadow-md"
          >
            <IconHand className="h-3 w-3" /> Hand raised
          </div>
        )}
        {isScreenShare && (
          <div
            data-testid={`av-screenshare-badge-${participant.identity}`}
            className="flex items-center gap-1 rounded-md bg-[var(--blue)] px-1.5 py-0.5 text-[0.625rem] font-semibold text-white shadow-md"
          >
            <IconScreen className="h-3 w-3" /> Screen
          </div>
        )}
        {(participant.quality === 'poor' || participant.quality === 'lost') && !handRaised && (
          <div
            data-testid={`av-quality-${participant.identity}`}
            className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium text-white shadow-md backdrop-blur-sm ${
              participant.quality === 'lost' ? 'bg-red-600/90' : 'bg-amber-600/90'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
            {participant.quality === 'lost' ? 'Lost connection' : 'Poor connection'}
          </div>
        )}
      </div>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-90 transition-opacity group-hover:opacity-100">
        {/*
          * No video, no picture-in-picture. The button used to render on the
          * camera-off avatar tiles where there is no <video> to send, so
          * pressing it silently did nothing.
          */}
        {(participant.camOn || isScreenShare) && (
          <button
            type="button"
            data-testid={`av-pip-${participant.identity}`}
            onClick={togglePictureInPicture}
            title="Picture in Picture"
            aria-label={`Picture in picture ${isLocal ? 'your camera' : displayName}`}
            className="inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center rounded-md border border-white/10 bg-slate-950/70 p-1.5 text-slate-200 backdrop-blur-md transition-colors duration-150 hover:bg-slate-800 hover:text-white shadow-sm"
          >
            <IconPictureInPicture className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          data-testid={`av-fullscreen-${participant.identity}`}
          onClick={toggleFullscreen}
          title="Fullscreen"
          aria-label={`Fullscreen ${isLocal ? 'your camera' : displayName}`}
          className="inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center rounded-md border border-white/10 bg-slate-950/70 p-1.5 text-slate-200 backdrop-blur-md transition-colors duration-150 hover:bg-slate-800 hover:text-white shadow-sm"
        >
          <IconFullscreen className="h-4 w-4" />
        </button>
      </div>
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1">
        <span
          data-testid="av-participant-name"
          className="flex min-w-0 items-center gap-1 truncate rounded-md border border-white/10 bg-slate-950/75 px-2 py-0.5 text-[0.6875rem] font-medium text-slate-200 backdrop-blur-md shadow-sm"
        >
          {/*
            * Beside the name rather than in the badge cluster above, which is
            * where Lessonspace puts it and what keeps that cluster for the
            * badges that come and go. Who is teaching is a property of the
            * person, so it belongs with their name.
            */}
          {isHost && (
            <span
              data-testid={`av-host-badge-${participant.identity}`}
              className="inline-flex shrink-0 items-center text-emerald-400"
              role="img"
              aria-label="Host"
              title="Host"
            >
              <IconCrown className="h-3 w-3" />
            </span>
          )}
          <span className="truncate">
            {displayName}
            {participant.micMuted ? ' · muted' : ''}
          </span>
        </span>
        {onFocus && (
          <button
            type="button"
            onClick={onFocus}
            aria-label={`Focus ${displayName}`}
            className={`rounded-md px-2 py-0.5 text-[0.6875rem] font-semibold transition-colors duration-150 shadow-sm ${
              pinned
                ? 'bg-[var(--blue)] text-white'
                : 'border border-white/10 bg-slate-950/75 text-slate-200 backdrop-blur-md hover:bg-slate-800 hover:text-white'
            }`}
          >
            {pinned ? 'Pinned' : 'Focus'}
          </button>
        )}
      </div>
    </div>
  );
}


/**
 * Grid of local + remote A/V tiles, with the mic, the camera and the device
 * pickers. The controls belong to the call, so they travel with it: the panel
 * moves and fullscreens, and a mute button on the far side of the screen from
 * the face being muted is one you have to go looking for. It also reaches the
 * guest hostname, which renders no top bar at all.
 * Rendered only for admitted participants (parent gates on !isWaiting).
 */
/**
 * Whether this viewer hid the call last time. A per-viewer convenience, so it
 * lives in their browser rather than in shared room state.
 *
 * Every access is guarded: the getter itself throws on an origin with storage
 * disabled, and a thrown preference must not stop the call rendering.
 */
const CALL_HIDDEN_KEY = 'whiteboard_call_hidden';

function readCallHidden(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(CALL_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCallHidden(hidden: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (hidden) localStorage.setItem(CALL_HIDDEN_KEY, '1');
    else localStorage.removeItem(CALL_HIDDEN_KEY);
  } catch {
    // Storage unavailable or full; the preference is not worth an error.
  }
}

export default function AvSessionPanel({
  av,
  localIdentity,
  users,
  collapsed = false,
  onOpenChange,
  onLeaveCall,
  onEndCallForEveryone,
}: AvSessionPanelProps) {
  const message = errorCopy(av);
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);
  const visibleMessage = message !== null && message !== dismissedMessage ? message : null;
  const tiles = useMemo(
    () => (av.participants.length > 0
      ? av.participants
      : [{ identity: localIdentity, micMuted: av.local.micMuted, micPresent: true, camOn: av.local.camOn, isSpeaking: false }]),
    [av.local.camOn, av.local.micMuted, av.participants, localIdentity],
  );
  const [open, setOpen] = useState(() => (collapsed ? false : !readCallHidden()));
  const [mode, setMode] = useState<AvPanelMode>('rail');
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  const [endCallConfirmOpen, setEndCallConfirmOpen] = useState(false);

  // Reported on mount too: the first answer comes from what this viewer last
  // chose, not from a default, so the board must not assume the rail is there.
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const panelRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const didMountRef = useRef(false);

  /*
   * Opening the call takes focus into it, hiding it gives focus back to the
   * pill. The panel is fixed and its DOM position follows the roster, so a
   * keyboard user who hid it was left focused on a button that had just been
   * removed. The first render is skipped: the starting state comes from a
   * stored preference, and page load must not steal focus from the board.
   */
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (open) panelRef.current?.focus();
    else openButtonRef.current?.focus();
  }, [open]);

  /*
   * Docked, not placed by hand. A right rail on a wide screen, a strip along
   * the bottom on a phone -- a 15rem sidebar there would leave nothing to draw
   * on.
   *
   * It floats over the board rather than narrowing it. ROOM_CANVAS_CLASS is
   * deliberately inset-x-0: narrowing the board for a fixed side panel left a
   * strip down each side that nothing ever painted into, and because that strip
   * came and went with the roster it resized the canvas under a live lesson.
   */
  const placement =
    /*
     * On a phone the strip hangs from the top, under the toolbar, because the
     * presence roster owns the bottom edge -- it is `bottom-0 inset-x-0` there.
     * Putting the call at the bottom too laid it straight over the roster's
     * moderation buttons and swallowed the clicks.
     *
     * The wide-screen rail pads itself clear of the safe areas: a landscape
     * notch cuts the bottom-right corner off a full-bleed side panel.
     */
    'inset-x-0 top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)] w-auto '
    + 'sm:inset-x-auto sm:right-0 sm:top-12 sm:bottom-0 '
    + 'sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] '
    + 'sm:pr-[max(0.75rem,env(safe-area-inset-right))] '
    // The width reaches CSS through the --call-rail-w variable, set inline
    // below: an interpolated arbitrary class is invisible to Tailwind's scan.
    + 'sm:w-[var(--call-rail-w)]';
  const recovery = callRecoveryAction(av.status, av.unavailableReason);
  const focusTile = pinnedIdentity
    ? tiles.find((participant) => participant.identity === pinnedIdentity) ?? null
    : tiles.find((participant) => participant.isSpeaking) ?? tiles[0] ?? null;
  const secondaryTiles = focusTile
    ? tiles.filter((participant) => participant.identity !== focusTile.identity)
    : [];

  useEffect(() => {
    if (pinnedIdentity && !tiles.some((participant) => participant.identity === pinnedIdentity)) {
      setPinnedIdentity(null);
    }
  }, [pinnedIdentity, tiles]);

  const selectMode = (nextMode: AvPanelMode) => {
    setMode(nextMode);
    if (nextMode !== 'focus') setPinnedIdentity(null);
  };

  /*
   * A radio group's keys: arrows move the selection and the focus together,
   * Home and End jump to the ends. Without this the ring of buttons announces
   * itself as radios and then ignores the keys that operate radios.
   */
  const handleLayoutKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = LAYOUT_OPTIONS.findIndex((option) => option.value === mode);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % LAYOUT_OPTIONS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + LAYOUT_OPTIONS.length) % LAYOUT_OPTIONS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = LAYOUT_OPTIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectMode(LAYOUT_OPTIONS[nextIndex].value);
    const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[nextIndex]?.focus();
  };

  const focusParticipant = (identity: string) => {
    setPinnedIdentity(identity);
    setMode('focus');
  };

  /*
   * Put away, this is a pill in the same corner rather than nothing at all.
   *
   * The call carries on behind it -- the mic and camera are still live, and
   * the top bar still says so -- so there has to be a way back to the faces.
   */
  if (!open) {
    return (
      <>
        {/*
          * Hidden puts the faces away; it does not leave the call. The audio
          * renderer is the only thing playing what other people are saying, so
          * unmounting it here left somebody sitting in a silent lesson with the
          * call still connected and the mic still live.
          */}
        {av.unavailableReason === null && av.room && (
          <RoomContext.Provider value={av.room}>
            <div data-testid="av-room-audio-renderer" aria-hidden className="absolute">
              <RoomAudioRenderer room={av.room} />
            </div>
          </RoomContext.Provider>
        )}
        <button
          ref={openButtonRef}
          type="button"
          data-testid="av-panel-open"
          onClick={() => { setOpen(true); writeCallHidden(false); }}
          className="fixed z-[1400] rounded-full border border-slate-700/80 bg-slate-900/95 px-3 py-1.5 text-[0.6875rem] font-medium text-slate-200 shadow-lg shadow-slate-900/30 left-2 top-[calc(max(0.5rem,env(safe-area-inset-top))+7rem)] sm:bottom-16 sm:left-14 sm:top-auto"
        >
          Show call ({tiles.length})
        </button>
      </>
    );
  }


  return (
    <div
      ref={panelRef}
      data-testid="av-session-panel"
      tabIndex={-1}
      style={{ ['--call-rail-w' as string]: CALL_RAIL_WIDTH } as React.CSSProperties}
      /*
       * Above the room's furniture, because it can be dragged over all of it:
       * the top nav (1100), the presence panel (1200, 1250 for its outside
       * layer) and the raised-hand cue (1300). The library and the shortcuts
       * sheet (10001) stay above -- those take the screen over on purpose.
       */
      className={`fixed z-[1400] flex flex-col rounded-b-2xl border-b border-slate-700/70 bg-slate-900/95 backdrop-blur-xl p-3 shadow-2xl shadow-slate-950/60 max-h-[40dvh] overflow-y-auto sm:max-h-none sm:rounded-none sm:border-b-0 sm:border-l sm:shadow-none ${placement}`}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="av-panel-collapse"
            onClick={() => { setOpen(false); writeCallHidden(true); }}
            aria-label="Hide the call"
            className="inline-flex min-h-9 pointer-coarse:min-h-11 items-center gap-1 rounded-lg px-2 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400 transition-colors duration-150 hover:bg-slate-800 hover:text-slate-200"
          >
            Hide
          </button>
          <div
            role="radiogroup"
            aria-label="Video layout"
            onKeyDown={handleLayoutKeyDown}
            className="inline-flex items-center gap-0.5 rounded-xl border border-slate-800 bg-slate-950/60 p-0.5 shadow-inner"
          >
            {LAYOUT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                tabIndex={mode === option.value ? 0 : -1}
                onClick={() => selectMode(option.value)}
                className={modeButtonClass(mode === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

      </div>

      {visibleMessage && (
        <div data-testid="av-status-message" role="alert" className="mb-2.5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200 shadow-sm leading-relaxed">
          <svg className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="min-w-0 flex-1">{visibleMessage}</span>
          <button
            type="button"
            data-testid="av-status-dismiss"
            aria-label="Dismiss message"
            title="Dismiss"
            onClick={() => setDismissedMessage(visibleMessage)}
            className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-lg text-amber-300 transition-colors duration-150 hover:bg-amber-500/20 hover:text-amber-100"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}

      {recovery && (
        <button
          type="button"
          data-testid="av-call-retry"
          onClick={av.retry}
          className="mb-2.5 w-full rounded-xl border border-[var(--blue)]/50 bg-[var(--blue)]/15 px-3 py-2 text-[0.6875rem] font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-[var(--blue)]/25"
        >
          {recovery === 'retry' ? 'Try again' : 'Rejoin'}
        </button>
      )}

      {/*
        * An unavailable call is the only thing with no faces behind it: not
        * configured, not admitted, not allowed. A refused device is a fault
        * within a call that is otherwise running, and hiding the call behind
        * the complaint took a working conversation off the screen with it.
        */}
      {av.unavailableReason === null && av.room && (
        <RoomContext.Provider value={av.room}>
          <div data-testid="av-room-audio-renderer" aria-hidden className="absolute">
            <RoomAudioRenderer room={av.room} />
          </div>
          <AudioPlaybackBanner room={av.room} />
          {mode === 'rail' && (
            <div
              data-testid="av-tiles-rail"
              /*
                * A row on a phone, where the strip runs across the top; a column
                * on a wide screen, where the rail is ~15rem and a row meant one
                * visible face and a sideways drag to find anyone else.
                * min-h-0 is what lets the column actually scroll rather than
                * pushing the controls off the bottom of the panel.
                */
              className="flex gap-2.5 overflow-x-auto pb-1.5 sm:flex-1 sm:min-h-0 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto"
            >
              {tiles.map((participant) => (
                <div
                  key={participant.identity}
                  className={`min-w-0 sm:w-full sm:shrink sm:basis-auto ${tiles.length === 1 ? 'w-full' : 'shrink-0 basis-44'}`}
                >
                  <ParticipantTile
                    participant={participant}
                    isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
                    av={av}
                    localIdentity={localIdentity}
                    users={users}
                    onFocus={() => focusParticipant(participant.identity)}
                  />
                </div>
              ))}
            </div>
          )}
          {mode === 'focus' && focusTile && (
            <div className="flex flex-col gap-2.5">
              <div data-testid="av-focus-primary" data-participant={focusTile.identity}>
                <ParticipantTile
                  participant={focusTile}
                  isLocal={focusTile.identity === localIdentity || focusTile.identity === '__local__'}
                  av={av}
                  localIdentity={localIdentity}
                  users={users}
                  onFocus={() => focusParticipant(focusTile.identity)}
                  pinned={pinnedIdentity === focusTile.identity}
                />
              </div>
              {secondaryTiles.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {secondaryTiles.map((participant) => (
                    <div key={participant.identity} className="min-w-0 shrink-0 basis-32">
                      <ParticipantTile
                        participant={participant}
                        isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
                        av={av}
                        localIdentity={localIdentity}
                        users={users}
                        onFocus={() => focusParticipant(participant.identity)}
                        pinned={pinnedIdentity === participant.identity}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </RoomContext.Provider>
      )}


      {/*
        * One cluster: the toggles, then a divider, then leaving and ending.
        * These two were in the panel header, at the far end from the mic and
        * camera -- every call product groups them with the other call
        * controls instead. The divider and the gap are what stop End for
        * everyone reading as one more toggle, and it stays apart from Leave
        * rather than adjacent to it.
        */}
      <div data-testid="av-call-cluster" className="mt-2.5 pt-2 border-t border-slate-800/80 sm:mt-auto">
        <CallControls av={av} />

        {(onLeaveCall || onEndCallForEveryone) && (
          <div className="mt-2 flex items-center gap-2 border-t border-slate-800/80 pt-2">
            {onLeaveCall && (
              <button
                type="button"
                data-testid="av-leave-call"
                onClick={onLeaveCall}
                title="Leave the call. It carries on for everyone else."
                className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-slate-500/40 bg-slate-500/15 px-3 text-[0.6875rem] font-semibold text-slate-200 shadow-sm transition-colors duration-150 hover:bg-slate-500/25 hover:border-slate-500/60 sm:min-h-8"
              >
                Leave
              </button>
            )}

            {onEndCallForEveryone && (
              <button
                type="button"
                data-testid="av-end-call-everyone"
                onClick={() => setEndCallConfirmOpen(true)}
                title="End the call for everyone in the room"
                className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-red-500 bg-red-600 px-3 text-[0.6875rem] font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-red-500 sm:min-h-8"
              >
                End for all
              </button>
            )}
          </div>
        )}
      </div>

      {((av.devices.microphone?.length ?? 0) > 1 || (av.devices.camera?.length ?? 0) > 1 || (av.devices.speaker?.length ?? 0) > 1) && (
        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-slate-700/80 pt-2.5">
          {av.devices.microphone.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Mic</span>
              <select
                data-testid="av-device-mic"
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 cursor-pointer"
                onChange={(event) => void av.selectDevice('microphone', event.target.value)}
                value={selectedDeviceValue(av.devices.microphone, av.activeDevices.microphone)}
              >
                <option value="" disabled>
                  Select microphone
                </option>
                {av.devices.microphone.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, 'Microphone')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {av.devices.camera.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Cam</span>
              <select
                data-testid="av-device-cam"
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 cursor-pointer"
                onChange={(event) => void av.selectDevice('camera', event.target.value)}
                value={selectedDeviceValue(av.devices.camera, av.activeDevices.camera)}
              >
                <option value="" disabled>
                  Select camera
                </option>
                {av.devices.camera.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, 'Camera')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(av.devices.speaker?.length ?? 0) > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Speaker</span>
              <select
                data-testid="av-device-speaker"
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 cursor-pointer"
                onChange={(event) => void av.selectDevice('speaker', event.target.value)}
                value={selectedDeviceValue(av.devices.speaker ?? [], av.activeDevices.speaker)}
              >
                <option value="" disabled>
                  Select speaker
                </option>
                {av.devices.speaker.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, 'Speaker')}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={endCallConfirmOpen}
        title="End the call for everyone?"
        body="Everyone in this room will be hung up on. The board stays as it is, and you can start a new call afterwards."
        confirmLabel="End for everyone"
        testIdPrefix="av-end-call-confirm"
        onConfirm={() => {
          setEndCallConfirmOpen(false);
          onEndCallForEveryone?.();
        }}
        onCancel={() => setEndCallConfirmOpen(false)}
      />
    </div>
  );
}

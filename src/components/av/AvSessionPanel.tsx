'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomContext, RoomAudioRenderer, VideoTrack, useAudioPlayback } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import { Track } from 'livekit-client';

import CallControls from './CallControls';
import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { AvDevice, ParticipantState } from '@/lib/av/avSession';
import { clampPanelPosition, type PanelPoint } from '@/lib/av/panelPosition';

export type AvPanelMode = 'rail' | 'focus' | 'off';

interface AvSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  /** Start out of the way rather than open. */
  readonly collapsed?: boolean;
  /**
   * Hang up, without leaving the room.
   *
   * The board carries on either way, so this is not the Leave in the bottom
   * bar. Absent where the call is not something the caller can end.
   */
  readonly onEndCall?: () => void;
}

function errorCopy(av: UseAvSessionResult): string | null {
  if (av.unavailableReason === 'unconfigured') {
    return 'Video calling is not configured on this server.';
  }
  if (av.unavailableReason === 'waiting') {
    return 'Join the room to enable camera and mic.';
  }
  if (av.unavailableReason === 'forbidden') {
    return 'You do not have access to video in this room.';
  }
  if (!av.error) return null;
  if (av.error.kind === 'permission-denied') {
    return 'Camera or microphone permission was denied.';
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

function modeButtonClass(active: boolean): string {
  return active
    ? 'rounded-lg bg-slate-800 px-3 py-1 text-[0.6875rem] font-semibold text-white shadow-sm border border-slate-700/80 transition-all'
    : 'rounded-lg px-3 py-1 text-[0.6875rem] font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-all';
}

function AudioPlaybackBanner({ room }: { readonly room: Room }) {
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  if (canPlayAudio) return null;
  return (
    <button
      type="button"
      data-testid="av-audio-unlock"
      onClick={() => void startAudio()}
      className="mb-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-center text-[0.6875rem] font-semibold text-amber-200 shadow-sm transition-all hover:bg-amber-500/30"
    >
      <span className="animate-bounce">🔊</span> Audio blocked by browser. Click to enable sound.
    </button>
  );
}

function ParticipantTile({
  participant,
  isLocal,
  av,
  onFocus,
  pinned = false,
}: {
  participant: ParticipantState;
  isLocal: boolean;
  av: UseAvSessionResult;
  onFocus?: (() => void) | null;
  pinned?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
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

  useEffect(() => {
    if (av.room) return;
    const video = videoRef.current;
    if (!video) return;
    av.attachTrack(participant.identity, 'camera', video);
    return () => {
      av.detachTrack(participant.identity, 'camera', video);
    };
  }, [av, participant.identity, participant.camOn]);

  const participantObj = av.room
    ? isLocal || participant.identity === '__local__'
      ? av.room.localParticipant
      : av.room.remoteParticipants.get(participant.identity)
    : null;
  const videoPublication = participantObj?.getTrackPublication(Track.Source.ScreenShare) ?? participantObj?.getTrackPublication(Track.Source.Camera);
  const trackRef = participantObj && videoPublication
    ? { participant: participantObj, publication: videoPublication, source: videoPublication.source }
    : null;
  const isScreenShare = videoPublication?.source === Track.Source.ScreenShare;
  const shouldMirror = isLocal && !isScreenShare;

  return (
    <div
      ref={tileRef}
      data-testid={`av-tile-${participant.identity}`}
      className={`group relative aspect-video overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/80 shadow-md transition-all [&:fullscreen]:aspect-auto [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none [&:fullscreen_video]:object-contain ${
        participant.isSpeaking ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-slate-900 shadow-lg shadow-emerald-500/20' : ''
      }`}
    >
      {av.room && trackRef && (participant.camOn || isScreenShare) ? (
        <VideoTrack
          trackRef={trackRef}
          data-testid={`av-video-track-${participant.identity}`}
          className={`h-full w-full object-cover ${shouldMirror ? '-scale-x-100' : ''}`}
        />
      ) : (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`h-full w-full object-cover ${shouldMirror ? '-scale-x-100' : ''} ${participant.camOn ? '' : 'hidden'}`}
        />
      )}
      {!participant.camOn && !isScreenShare && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-b from-slate-800/90 to-slate-950/95 p-2 text-slate-300">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-600/60 bg-slate-700/60 text-xs font-bold text-slate-200 shadow-inner">
            {(isLocal ? 'You' : participant.identity).slice(0, 2).toUpperCase()}
          </div>
          <span className="text-[0.6875rem] font-medium text-slate-400">
            Camera off
          </span>
        </div>
      )}
      {(participant.quality === 'poor' || participant.quality === 'lost') && (
        <div
          data-testid={`av-quality-${participant.identity}`}
          className={`absolute left-1.5 top-1.5 z-10 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium text-white shadow-md backdrop-blur-sm ${
            participant.quality === 'lost' ? 'bg-rose-600/90' : 'bg-amber-600/90'
          }`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          {participant.quality === 'lost' ? 'Lost connection' : 'Poor connection'}
        </div>
      )}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-90 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          data-testid={`av-pip-${participant.identity}`}
          onClick={togglePictureInPicture}
          title="Picture in Picture"
          aria-label={`Picture in picture ${isLocal ? 'your camera' : participant.identity}`}
          className="rounded-md border border-white/10 bg-slate-950/70 p-1 text-[0.6875rem] text-slate-200 backdrop-blur-md transition-all hover:bg-slate-800 hover:text-white shadow-sm"
        >
          ⧉
        </button>
        <button
          type="button"
          data-testid={`av-fullscreen-${participant.identity}`}
          onClick={toggleFullscreen}
          title="Fullscreen"
          aria-label={`Fullscreen ${isLocal ? 'your camera' : participant.identity}`}
          className="rounded-md border border-white/10 bg-slate-950/70 p-1 text-[0.6875rem] text-slate-200 backdrop-blur-md transition-all hover:bg-slate-800 hover:text-white shadow-sm"
        >
          ⛶
        </button>
      </div>
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1">
        <span className="truncate rounded-md border border-white/10 bg-slate-950/75 px-2 py-0.5 text-[0.6875rem] font-medium text-slate-200 backdrop-blur-md shadow-sm">
          {isLocal ? 'You' : participant.identity}
          {participant.micMuted ? ' · muted' : ''}
        </span>
        {onFocus && (
          <button
            type="button"
            onClick={onFocus}
            aria-label={`Focus ${isLocal ? 'you' : participant.identity}`}
            className={`rounded-md px-2 py-0.5 text-[0.6875rem] font-medium transition-all shadow-sm ${
              pinned
                ? 'bg-sky-500 text-white shadow-sky-500/30 font-semibold'
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

function RemoteParticipantAudio({
  participant,
  av,
}: {
  participant: ParticipantState;
  av: UseAvSessionResult;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    av.attachTrack(participant.identity, 'microphone', audio);
    return () => {
      av.detachTrack(participant.identity, 'microphone', audio);
    };
  }, [av, participant.identity]);

  return (
    <audio
      ref={audioRef}
      data-testid={`av-remote-audio-${participant.identity}`}
      autoPlay
      playsInline
      className="absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [-webkit-clip-path:inset(50%)] [clip-path:inset(50%)] [clip:rect(0,0,0,0)]"
    />
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
export default function AvSessionPanel({
  av,
  localIdentity,
  collapsed = false,
  onEndCall,
}: AvSessionPanelProps) {
  const message = errorCopy(av);
  const tiles = useMemo(
    () => (av.participants.length > 0
      ? av.participants
      : [{ identity: localIdentity, micMuted: av.local.micMuted, micPresent: true, camOn: av.local.camOn, isSpeaking: false }]),
    [av.local.camOn, av.local.micMuted, av.participants, localIdentity],
  );
  const [open, setOpen] = useState(!collapsed);
  const [mode, setMode] = useState<AvPanelMode>('rail');
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PanelPoint | null>(null);
  /** Where in the panel it was grabbed, so it does not jump under the pointer. */
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    grabRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.preventDefault();
  }, []);

  /*
   * The move and the release are listened for on the window, not the handle.
   *
   * A pointer moving faster than React re-renders leaves the handle behind,
   * and a release that lands anywhere else would never be heard -- the panel
   * would then follow the pointer around with no button held down.
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const grab = grabRef.current;
      if (!grab) return;
      const rect = panelRef.current?.getBoundingClientRect();
      setPosition(
        clampPanelPosition({
          x: event.clientX - grab.dx,
          y: event.clientY - grab.dy,
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    const onRelease = () => {
      grabRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, []);

  /*
   * A window that shrinks under a panel parked at the far edge would leave it
   * off screen, and the handle with it.
   */
  useEffect(() => {
    if (!position) return;
    const onResize = () => {
      const rect = panelRef.current?.getBoundingClientRect();
      setPosition((current) =>
        current === null
          ? null
          : clampPanelPosition({
              ...current,
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            }),
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [position]);

  // Placed by hand, the panel stops taking its position from the stylesheet --
  // but it still needs a width, which the parked classes were supplying.
  const placement = position
    ? 'w-[min(26.25rem,calc(100vw-1rem))]'
    : 'left-2 right-14 top-[calc(max(0.5rem,env(safe-area-inset-top))+3.5rem)] w-auto sm:bottom-16 sm:left-14 sm:right-auto sm:top-auto sm:w-[min(26.25rem,calc(100vw-18.75rem))]';
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
    // The pill stands in for the panel, so it stands where the panel was put:
    // returning to the default corner would undo a deliberate move.
    return (
      <button
        type="button"
        data-testid="av-panel-open"
        onClick={() => setOpen(true)}
        className={`fixed z-[1400] rounded-full border border-slate-700/80 bg-slate-900/95 px-3 py-1.5 text-[0.6875rem] font-medium text-slate-200 shadow-lg shadow-slate-900/30 ${
          position
            ? ''
            : 'left-2 top-[calc(max(0.5rem,env(safe-area-inset-top))+3.5rem)] sm:bottom-16 sm:left-14 sm:top-auto'
        }`}
        style={position ? { left: position.x, top: position.y } : undefined}
      >
        Show call ({tiles.length})
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      data-testid="av-session-panel"
      /*
       * Above the room's furniture, because it can be dragged over all of it:
       * the top nav (1100), the presence panel (1200, 1250 for its outside
       * layer) and the raised-hand cue (1300). The library and the shortcuts
       * sheet (10001) stay above -- those take the screen over on purpose.
       */
      className={`fixed z-[1400] rounded-2xl border border-slate-700/70 bg-slate-900/95 backdrop-blur-xl p-3 shadow-2xl shadow-slate-950/60 ${placement}`}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="av-panel-collapse"
            onClick={() => setOpen(false)}
            aria-label="Hide the call"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wider text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          >
            Hide
          </button>
          <div
            role="radiogroup"
            aria-label="Video layout"
            className="inline-flex items-center gap-0.5 rounded-xl border border-slate-800 bg-slate-950/60 p-0.5 shadow-inner"
          >
            {(['rail', 'focus', 'off'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                onClick={() => selectMode(option)}
                className={modeButtonClass(mode === option)}
              >
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/*
          * The grip is the empty middle of the header, which is space the
          * panel already had. `touch-action: none` is what stops a drag on a
          * phone being read as a scroll of the board underneath.
          */}
        <div
          data-testid="av-panel-drag"
          onPointerDown={startDrag}
          role="presentation"
          title="Drag to move"
          className="flex flex-1 cursor-move touch-none items-center justify-center self-stretch px-2 text-slate-500 hover:text-slate-400"
        >
          <span aria-hidden className="inline-flex items-center gap-0.5 rounded-full bg-slate-800/80 px-2 py-0.5 text-[0.6875rem] text-slate-400">⠿</span>
        </div>

        {onEndCall && (
          <button
            type="button"
            data-testid="av-end-call"
            onClick={onEndCall}
            title="Leave the call"
            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-[0.6875rem] font-medium text-rose-300 transition-all shadow-sm hover:bg-rose-500/25 hover:border-rose-500/60 shrink-0"
          >
            End
          </button>
        )}
      </div>

      {message && (
        <div data-testid="av-status-message" className="mb-2.5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200 shadow-sm leading-relaxed">
          <svg className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>{message}</span>
        </div>
      )}

      {/*
        * An unavailable call is the only thing with no faces behind it: not
        * configured, not admitted, not allowed. A refused device is a fault
        * within a call that is otherwise running, and hiding the call behind
        * the complaint took a working conversation off the screen with it.
        */}
      {av.unavailableReason === null && (
        <>
          {av.room ? (
            <RoomContext.Provider value={av.room}>
              <div data-testid="av-room-audio-renderer" aria-hidden className="absolute">
                <RoomAudioRenderer room={av.room} />
              </div>
              <AudioPlaybackBanner room={av.room} />
              {mode === 'rail' && (
                <div data-testid="av-tiles-rail" className="flex gap-2.5 overflow-x-auto pb-1.5">
                  {tiles.map((participant) => (
                    <div key={participant.identity} className="min-w-0 shrink-0 basis-44 sm:basis-48">
                      <ParticipantTile
                        participant={participant}
                        isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
                        av={av}
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
          ) : (
            <>
              <div aria-hidden className="absolute">
                {tiles
                  .filter((participant) => participant.identity !== localIdentity && participant.identity !== '__local__')
                  .map((participant) => (
                    <RemoteParticipantAudio
                      key={participant.identity}
                      participant={participant}
                      av={av}
                    />
                  ))}
              </div>
              {mode === 'rail' && (
                <div data-testid="av-tiles-rail" className="flex gap-2.5 overflow-x-auto pb-1.5">
                  {tiles.map((participant) => (
                    <div key={participant.identity} className="min-w-0 shrink-0 basis-44 sm:basis-48">
                      <ParticipantTile
                        participant={participant}
                        isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
                        av={av}
                        onFocus={() => focusParticipant(participant.identity)}
                      />
                    </div>
                  ))}
                </div>
              )}
              {mode === 'focus' && focusTile && (
                <div className="flex flex-col gap-2">
                  <div data-testid="av-focus-primary" data-participant={focusTile.identity}>
                    <ParticipantTile
                      participant={focusTile}
                      isLocal={focusTile.identity === localIdentity || focusTile.identity === '__local__'}
                      av={av}
                      onFocus={() => focusParticipant(focusTile.identity)}
                      pinned={pinnedIdentity === focusTile.identity}
                    />
                  </div>
                  {secondaryTiles.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {secondaryTiles.map((participant) => (
                        <div key={participant.identity} className="min-w-0 shrink-0 basis-28">
                          <ParticipantTile
                            participant={participant}
                            isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
                            av={av}
                            onFocus={() => focusParticipant(participant.identity)}
                            pinned={pinnedIdentity === participant.identity}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="mt-2.5 pt-2 border-t border-slate-800/80">
        <CallControls av={av} />
      </div>

      {((av.devices.microphone?.length ?? 0) > 1 || (av.devices.camera?.length ?? 0) > 1 || (av.devices.speaker?.length ?? 0) > 1) && (
        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-slate-700/80 pt-2.5">
          {av.devices.microphone.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Mic</span>
              <select
                data-testid="av-device-mic"
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
                onChange={(event) => void av.selectDevice('microphone', event.target.value)}
                defaultValue=""
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
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
                onChange={(event) => void av.selectDevice('camera', event.target.value)}
                defaultValue=""
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
                className="min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 py-1 text-xs text-slate-200 shadow-sm transition-colors hover:border-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
                onChange={(event) => void av.selectDevice('speaker', event.target.value)}
                defaultValue=""
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
    </div>
  );
}

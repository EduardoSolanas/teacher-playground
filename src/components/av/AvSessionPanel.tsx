'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import CallControls from './CallControls';
import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { AvDevice, ParticipantState } from '@/lib/av/avSession';
import { clampPanelPosition, type PanelPoint } from '@/lib/av/panelPosition';

interface AvSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  readonly isLocalHost: boolean;
  /** Start out of the way rather than open. */
  readonly collapsed?: boolean;
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
function deviceLabel(device: AvDevice, index: number, kind: 'Microphone' | 'Camera'): string {
  return device.label.trim() || `${kind} ${index + 1}`;
}

function ParticipantTile({
  participant,
  isLocal,
  isLocalHost,
  av,
}: {
  participant: ParticipantState;
  isLocal: boolean;
  isLocalHost: boolean;
  av: UseAvSessionResult;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
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

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;
    av.attachTrack(participant.identity, 'camera', video);
    if (!isLocal && audio) {
      av.attachTrack(participant.identity, 'microphone', audio);
    }
    return () => {
      av.detachTrack(participant.identity, 'camera', video);
      if (!isLocal && audio) {
        av.detachTrack(participant.identity, 'microphone', audio);
      }
    };
  }, [av, participant.identity, participant.camOn, isLocal]);

  return (
    <div
      ref={tileRef}
      data-testid={`av-tile-${participant.identity}`}
      className="group relative aspect-video overflow-hidden rounded-lg bg-slate-800 [&:fullscreen]:aspect-auto [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none [&:fullscreen_video]:object-contain"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`h-full w-full object-cover ${participant.camOn ? '' : 'hidden'}`}
      />
      {!participant.camOn && (
        <div className="flex h-full w-full items-center justify-center text-sm text-slate-300">
          Camera off
        </div>
      )}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline />}
      <button
        type="button"
        data-testid={`av-fullscreen-${participant.identity}`}
        onClick={toggleFullscreen}
        title="Fullscreen"
        aria-label={`Fullscreen ${isLocal ? 'your camera' : participant.identity}`}
        className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[0.6875rem] text-white transition-colors hover:bg-black/80"
      >
        {/* A glyph rather than a word: the tile is small and the corner is all
            the room there is. */}
        ⛶
      </button>
      <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between gap-1">
        <span className="truncate rounded bg-black/60 px-1.5 py-0.5 text-[0.6875rem] text-white">
          {isLocal ? 'You' : participant.identity}
          {participant.micMuted ? ' · muted' : ''}
        </span>
        {isLocalHost && !isLocal && !participant.micMuted && (
          <button
            type="button"
            data-testid={`av-host-mute-${participant.identity}`}
            className="rounded bg-black/60 px-1.5 py-0.5 text-[0.6875rem] text-amber-200 hover:bg-black/80"
            onClick={() => av.requestMute(participant.identity)}
            title="Request mute"
          >
            Mute
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
export default function AvSessionPanel({
  av,
  localIdentity,
  isLocalHost,
  collapsed = false,
}: AvSessionPanelProps) {
  const message = errorCopy(av);
  const tiles = av.participants.length > 0
    ? av.participants
    : [{ identity: localIdentity, micMuted: av.local.micMuted, camOn: av.local.camOn }];
  const [open, setOpen] = useState(!collapsed);
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
      className={`fixed z-[1400] rounded-xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-xl shadow-slate-900/30 ${placement}`}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          data-testid="av-panel-collapse"
          onClick={() => setOpen(false)}
          aria-label="Hide the call"
          className="rounded-md px-1.5 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
        >
          Hide
        </button>
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
          className="flex flex-1 cursor-move touch-none items-center justify-center self-stretch text-slate-500"
        >
          <span aria-hidden className="text-[0.75rem] leading-none tracking-[0.2em]">⠿</span>
        </div>
        <CallControls av={av} />
      </div>

      {message && (
        <p data-testid="av-status-message" className="px-1 pb-2 text-[0.75rem] text-amber-200">
          {message}
        </p>
      )}

      {/*
        * An unavailable call is the only thing with no faces behind it: not
        * configured, not admitted, not allowed. A refused device is a fault
        * within a call that is otherwise running, and hiding the call behind
        * the complaint took a working conversation off the screen with it.
        */}
      {av.unavailableReason === null && (
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((participant) => (
            <ParticipantTile
              key={participant.identity}
              participant={participant}
              isLocal={participant.identity === localIdentity || participant.identity === '__local__'}
              isLocalHost={isLocalHost}
              av={av}
            />
          ))}
        </div>
      )}

      {(av.devices.microphone.length > 1 || av.devices.camera.length > 1) && (
        <div className="mt-2 flex flex-col gap-1 border-t border-slate-700 pt-2">
          {av.devices.microphone.length > 1 && (
            <label className="flex items-center gap-2 text-[0.6875rem] text-slate-300">
              Mic
              <select
                data-testid="av-device-mic"
                className="min-w-0 flex-1 truncate rounded border border-slate-600 bg-slate-800 px-1 py-0.5"
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
            <label className="flex items-center gap-2 text-[0.6875rem] text-slate-300">
              Cam
              <select
                data-testid="av-device-cam"
                className="min-w-0 flex-1 truncate rounded border border-slate-600 bg-slate-800 px-1 py-0.5"
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
        </div>
      )}
    </div>
  );
}

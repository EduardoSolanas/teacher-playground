'use client';

import { useEffect, useRef, useState } from 'react';

import CallControls from './CallControls';
import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { AvDevice, ParticipantState } from '@/lib/av/avSession';

interface AvSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  readonly isLocalHost: boolean;
  /** Start out of the way rather than open. */
  readonly collapsed?: boolean;
  /**
   * Hold the mic and camera here after all.
   *
   * They live in the top bar now, which the guest hostname does not render --
   * and that is the student side of a lesson, so without this the person most
   * likely to need to mute in a hurry would have nothing to press.
   */
  readonly showControls?: boolean;
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
      data-testid={`av-tile-${participant.identity}`}
      className="relative aspect-video overflow-hidden rounded-lg bg-slate-800"
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
 * Grid of local + remote A/V tiles, and the device pickers. The mic and
 * camera live in the top bar; this holds them only where there is no bar.
 * Rendered only for admitted participants (parent gates on !isWaiting).
 */
export default function AvSessionPanel({
  av,
  localIdentity,
  isLocalHost,
  collapsed = false,
  showControls = false,
}: AvSessionPanelProps) {
  const message = errorCopy(av);
  const tiles = av.participants.length > 0
    ? av.participants
    : [{ identity: localIdentity, micMuted: av.local.micMuted, camOn: av.local.camOn }];
  const [open, setOpen] = useState(!collapsed);

  /*
   * Put away, this is a pill in the same corner rather than nothing at all.
   *
   * The call carries on behind it -- the mic and camera are still live, and
   * the top bar still says so -- so there has to be a way back to the faces.
   */
  if (!open) {
    return (
      <button
        type="button"
        data-testid="av-panel-open"
        onClick={() => setOpen(true)}
        className="fixed left-2 top-[calc(max(0.5rem,env(safe-area-inset-top))+3.5rem)] z-[180] rounded-full border border-slate-700/80 bg-slate-900/95 px-3 py-1.5 text-[0.6875rem] font-medium text-slate-200 shadow-lg shadow-slate-900/30 sm:bottom-16 sm:left-14 sm:top-auto"
      >
        Show call ({tiles.length})
      </button>
    );
  }

  return (
    <div
      data-testid="av-session-panel"
      className="fixed left-2 right-14 top-[calc(max(0.5rem,env(safe-area-inset-top))+3.5rem)] z-[180] w-auto rounded-xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-xl shadow-slate-900/30 sm:bottom-16 sm:left-14 sm:right-auto sm:top-auto sm:w-[min(26.25rem,calc(100vw-18.75rem))]"
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
        {showControls && <CallControls av={av} />}
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

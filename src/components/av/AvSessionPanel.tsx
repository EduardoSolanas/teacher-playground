'use client';

import { useEffect, useRef } from 'react';

import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { ParticipantState } from '@/lib/av/avSession';

interface AvSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  readonly isLocalHost: boolean;
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
    return 'No camera or microphone was found.';
  }
  if (av.error.kind === 'network') {
    return 'Could not connect to the video room.';
  }
  return av.error.message;
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
        <span className="truncate rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
          {isLocal ? 'You' : participant.identity}
          {participant.micMuted ? ' · muted' : ''}
        </span>
        {isLocalHost && !isLocal && !participant.micMuted && (
          <button
            type="button"
            data-testid={`av-host-mute-${participant.identity}`}
            className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-black/80"
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
 * Basic grid of local + remote A/V tiles with mic/camera/device controls.
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

  if (collapsed) return null;

  return (
    <div
      data-testid="av-session-panel"
      className="fixed bottom-16 left-14 z-[180] w-[min(420px,calc(100vw-300px))] rounded-xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-xl shadow-slate-900/30"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Call
          {av.status === 'connecting' ? ' · connecting…' : ''}
          {av.status === 'joined' ? ' · live' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="av-toggle-mic"
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
            onClick={av.toggleMicrophone}
            disabled={av.status === 'idle' && !av.unavailableReason}
          >
            {av.local.micMuted ? 'Unmute' : 'Mute'}
          </button>
          <button
            type="button"
            data-testid="av-toggle-cam"
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
            onClick={av.toggleCamera}
            disabled={av.status === 'idle' && !av.unavailableReason}
          >
            {av.local.camOn ? 'Camera off' : 'Camera on'}
          </button>
        </div>
      </div>

      {message ? (
        <p data-testid="av-status-message" className="px-1 pb-2 text-[12px] text-amber-200">
          {message}
        </p>
      ) : (
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
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              Mic
              <select
                data-testid="av-device-mic"
                className="flex-1 rounded border border-slate-600 bg-slate-800 px-1 py-0.5"
                onChange={(event) => void av.selectDevice('microphone', event.target.value)}
                defaultValue=""
              >
                <option value="" disabled>
                  Select microphone
                </option>
                {av.devices.microphone.map((id) => (
                  <option key={id} value={id}>
                    {id.slice(0, 12)}…
                  </option>
                ))}
              </select>
            </label>
          )}
          {av.devices.camera.length > 1 && (
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              Cam
              <select
                data-testid="av-device-cam"
                className="flex-1 rounded border border-slate-600 bg-slate-800 px-1 py-0.5"
                onChange={(event) => void av.selectDevice('camera', event.target.value)}
                defaultValue=""
              >
                <option value="" disabled>
                  Select camera
                </option>
                {av.devices.camera.map((id) => (
                  <option key={id} value={id}>
                    {id.slice(0, 12)}…
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

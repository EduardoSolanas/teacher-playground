'use client';

import { useEffect, useRef } from 'react';

import type { UseAvSessionResult } from '@/hooks/useAvSession';
import type { ParticipantState } from '@/lib/av/avSession';

interface VoiceSessionPanelProps {
  readonly av: UseAvSessionResult;
  readonly localIdentity: string;
  readonly isLocalHost: boolean;
}

function errorCopy(av: UseAvSessionResult): string | null {
  if (av.unavailableReason === 'unconfigured') {
    return 'Voice calling is not configured on this server.';
  }
  if (av.unavailableReason === 'waiting') {
    return 'Join the room to enable your microphone.';
  }
  if (av.unavailableReason === 'forbidden') {
    return 'You do not have access to voice in this room.';
  }
  if (!av.error) return null;
  if (av.error.kind === 'permission-denied') {
    return 'Microphone permission was denied. Enable it in the browser to join voice.';
  }
  if (av.error.kind === 'device-missing') {
    return 'No microphone was found on this device.';
  }
  if (av.error.kind === 'network') {
    return 'Could not connect to the voice room.';
  }
  return av.error.message;
}

function RemoteAudio({
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
    return () => av.detachTrack(participant.identity, 'microphone', audio);
  }, [av, participant.identity, participant.micMuted]);

  return <audio ref={audioRef} autoPlay playsInline data-testid={`av-audio-${participant.identity}`} />;
}

/**
 * Audio-only call controls for admitted participants.
 * Parent must gate on !isWaiting so waiting-room peers never mount this.
 */
export default function VoiceSessionPanel({
  av,
  localIdentity,
  isLocalHost,
}: VoiceSessionPanelProps) {
  const message = errorCopy(av);
  const remotes = av.participants.filter(
    (p) => p.identity !== '__local__' && p.identity !== localIdentity,
  );
  const roster: ParticipantState[] =
    av.participants.length > 0
      ? av.participants
      : [{ identity: localIdentity, micMuted: av.local.micMuted, camOn: false }];

  return (
    <div
      data-testid="av-voice-panel"
      className="fixed bottom-16 left-14 z-[180] w-[min(360px,calc(100vw-300px))] rounded-xl border border-slate-700/80 bg-slate-900/95 p-2 shadow-xl shadow-slate-900/30"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Voice
          {av.status === 'connecting' ? ' · connecting…' : ''}
          {av.status === 'joined' ? ' · live' : ''}
        </span>
        <button
          type="button"
          data-testid="av-toggle-mic"
          className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          onClick={av.toggleMicrophone}
          disabled={av.status !== 'joined'}
        >
          {av.local.micMuted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      {message ? (
        <p data-testid="av-status-message" className="px-1 pb-1 text-[12px] text-amber-200">
          {message}
        </p>
      ) : (
        <ul className="space-y-1 px-1 pb-1" data-testid="av-voice-roster">
          {roster.map((participant) => {
            const isLocal =
              participant.identity === localIdentity || participant.identity === '__local__';
            return (
              <li
                key={participant.identity}
                data-testid={`av-voice-peer-${participant.identity}`}
                className="flex items-center justify-between gap-2 rounded-md bg-slate-800/80 px-2 py-1 text-[12px] text-slate-200"
              >
                <span className="truncate">
                  {isLocal ? 'You' : participant.identity}
                  {participant.micMuted ? (
                    <span className="text-amber-300" data-testid={`av-muted-${participant.identity}`}>
                      {' '}
                      · muted
                    </span>
                  ) : null}
                </span>
                {isLocalHost && !isLocal && !participant.micMuted ? (
                  <button
                    type="button"
                    data-testid={`av-host-mute-${participant.identity}`}
                    className="rounded bg-black/40 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-black/70"
                    onClick={() => av.requestMute(participant.identity)}
                    title="Request mute"
                  >
                    Mute
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {remotes.map((participant) => (
        <RemoteAudio key={participant.identity} participant={participant} av={av} />
      ))}

      {av.devices.microphone.length > 1 && (
        <label className="mt-1 flex items-center gap-2 border-t border-slate-700 px-1 pt-2 text-[11px] text-slate-300">
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
    </div>
  );
}

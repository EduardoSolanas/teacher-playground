'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ajaxFetch } from '@/lib/http/ajaxFetch';
import {
  createAvSession,
  type AvDevice,
  type AvError,
  type AvSession,
  type AvSessionSnapshot,
  type AvSessionStatus,
  type DeviceKind,
  type ParticipantState,
} from '@/lib/av/avSession';
import { LiveKitProvider } from '@/lib/av/livekitProvider';

export interface UseAvSessionOptions {
  readonly roomId: string;
  /** Stable LiveKit identity — typically the whiteboard peer id. */
  readonly identity: string;
  readonly displayName: string;
  /** When false, tear down any active A/V session (waiting / kicked / left). */
  readonly enabled: boolean;
}

export interface UseAvSessionResult {
  readonly status: AvSessionStatus;
  readonly error: AvError | null;
  readonly local: { micMuted: boolean; camOn: boolean };
  readonly participants: ParticipantState[];
  readonly devices: Record<DeviceKind, AvDevice[]>;
  readonly unavailableReason: 'unconfigured' | 'forbidden' | 'waiting' | null;
  readonly toggleMicrophone: () => void;
  readonly toggleCamera: () => void;
  readonly selectDevice: (kind: DeviceKind, deviceId: string) => Promise<void>;
  readonly requestMute: (identity: string) => Promise<void>;
  readonly attachTrack: (
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ) => void;
  readonly detachTrack: (
    identity: string,
    kind: 'camera' | 'microphone',
    element: HTMLMediaElement,
  ) => void;
  readonly leave: () => void;
}

interface TokenResponse {
  token?: string;
  url?: string;
  error?: string;
  reason?: string;
}

const EMPTY_SNAPSHOT: AvSessionSnapshot = {
  status: 'idle',
  error: null,
  local: { micMuted: false, camOn: false },
  participants: [],
  devices: { microphone: [], camera: [] },
};

/**
 * Fetches a short-lived LiveKit token and drives the voice session while the
 * caller is an admitted room participant. Disabled while waiting / kicked.
 */
export function useAvSession(options: UseAvSessionOptions): UseAvSessionResult {
  const { roomId, identity, displayName, enabled } = options;
  const sessionRef = useRef<AvSession | null>(null);
  const providerRef = useRef<LiveKitProvider | null>(null);
  const [session, setSession] = useState<AvSession | null>(null);
  const [startupError, setStartupError] = useState<AvError | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<
    'unconfigured' | 'forbidden' | 'waiting' | null
  >(null);
  const sessionSnapshot = useSyncExternalStore(
    useCallback((onStoreChange) => session?.subscribe(onStoreChange) ?? (() => {}), [session]),
    useCallback(() => session?.getSnapshot() ?? EMPTY_SNAPSHOT, [session]),
    () => EMPTY_SNAPSHOT,
  );
  const state = session
    ? sessionSnapshot
    : startupError
      ? { ...EMPTY_SNAPSHOT, status: 'error' as const, error: startupError }
      : EMPTY_SNAPSHOT;

  const leave = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    setSession(null);
    providerRef.current = null;
    setStartupError(null);
    setUnavailableReason(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      leave();
      return;
    }
    if (!identity) return;

    let cancelled = false;

    async function start() {
      // Identity is not sent: the server always binds the LiveKit identity
      // to the verified account, so a client-chosen value would be ignored.
      const params = new URLSearchParams({
        roomId,
        name: displayName,
      });
      const response = await ajaxFetch(`/api/av/token?${params.toString()}`, {
        method: 'POST',
      });
      if (cancelled) return;

      if (response.status === 503) {
        setUnavailableReason('unconfigured');
        return;
      }
      if (response.status === 403) {
        const body = (await response.json().catch(() => ({}))) as TokenResponse;
        setUnavailableReason(body.reason === 'waiting' ? 'waiting' : 'forbidden');
        return;
      }
      if (!response.ok) {
        setSession(null);
        setStartupError({ kind: 'unknown', message: `Token request failed (${response.status})` });
        return;
      }

      const body = (await response.json()) as TokenResponse;
      if (!body.token || !body.url) {
        setUnavailableReason('unconfigured');
        return;
      }

      const provider = new LiveKitProvider();
      const session = createAvSession(provider);
      providerRef.current = provider;
      sessionRef.current = session;
      setSession(session);
      setStartupError(null);
      setUnavailableReason(null);

      await session.join(body.token, body.url);
      if (cancelled) {
        session.leave();
        return;
      }
    }

    /*
     * The join is awaited nowhere else, so its rejection has to be caught
     * here.
     *
     * A token the media server refuses -- an API key that does not belong to
     * the configured project, a secret that has been rotated on one side only
     * -- rejects out of `connect`, and with `void start()` alone that became
     * an unhandled rejection and nothing more. The console filled with failed
     * sockets while the panel sat there saying nothing was wrong, which is the
     * worst way for a call to be broken: the teacher has no idea whether to
     * wait, retry, or carry on without it.
     *
     * Nothing is retried. The failures worth reporting here are refusals, and
     * a refusal repeated is a refusal; the reconnect the SDK already performs
     * covers a connection that merely dropped.
     */
    void start().catch((error: unknown) => {
      if (cancelled) return;
      setSession(null);
      sessionRef.current = null;
      providerRef.current = null;
      setStartupError({
        kind: 'unknown',
        message:
          error instanceof Error && error.message
            ? `Could not join the call: ${error.message}`
            : 'Could not join the call.',
      });
      setUnavailableReason(null);
    });

    return () => {
      cancelled = true;
      leave();
    };
  }, [enabled, roomId, identity, displayName, leave]);

  useEffect(() => {
    const onPageHide = () => leave();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [leave]);

  return {
    status: state.status,
    error: state.error,
    local: { ...state.local },
    participants: [...state.participants],
    devices: {
      microphone: [...state.devices.microphone],
      camera: [...state.devices.camera],
    },
    unavailableReason,
    toggleMicrophone: () => {
      sessionRef.current?.toggleMicrophone();
    },
    toggleCamera: () => {
      sessionRef.current?.toggleCamera();
    },
    selectDevice: async (kind, deviceId) => {
      await sessionRef.current?.selectDevice(kind, deviceId);
    },
    requestMute: async (target) => {
      await ajaxFetch(`/api/av/mute?${new URLSearchParams({ roomId }).toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
    },
    attachTrack: (id, kind, el) => sessionRef.current?.attachTrack(id, kind, el),
    detachTrack: (id, kind, el) => sessionRef.current?.detachTrack(id, kind, el),
    leave,
  };
}

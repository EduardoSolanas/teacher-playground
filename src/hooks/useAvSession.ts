'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { Room } from 'livekit-client';
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
  readonly local: { micMuted: boolean; camOn: boolean; isScreenSharing?: boolean };
  readonly participants: readonly ParticipantState[];
  readonly devices: Readonly<Record<DeviceKind, readonly AvDevice[]>>;
  readonly unavailableReason: 'unconfigured' | 'forbidden' | 'waiting' | null;
  readonly room: Room | null;
  readonly toggleMicrophone: () => void;
  readonly toggleCamera: () => void;
  readonly toggleScreenShare: () => Promise<void>;
  readonly selectDevice: (kind: DeviceKind, deviceId: string) => Promise<void>;
  readonly requestMute: (identity: string, kind?: 'audio' | 'video') => Promise<void>;
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
  local: { micMuted: false, camOn: false, isScreenSharing: false },
  participants: [],
  devices: { microphone: [], camera: [], speaker: [] },
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
  const [room, setRoom] = useState<Room | null>(null);
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
    setRoom(null);
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
        setRoom(null);
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
      setRoom(provider.getRoom());
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
      setRoom(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- renaming updates participant name directly to avoid tearing down the call
  }, [enabled, roomId, identity, leave]);

  useEffect(() => {
    if (room && displayName) {
      void room.localParticipant?.setName(displayName).catch(() => {});
    }
  }, [room, displayName]);

  useEffect(() => {
    const onPageHide = () => leave();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [leave]);

  const toggleMicrophone = useCallback(() => {
    sessionRef.current?.toggleMicrophone();
  }, []);

  const toggleCamera = useCallback(() => {
    sessionRef.current?.toggleCamera();
  }, []);

  const toggleScreenShare = useCallback(async () => {
    await sessionRef.current?.toggleScreenShare();
  }, []);

  const selectDevice = useCallback(async (kind: DeviceKind, deviceId: string) => {
    await sessionRef.current?.selectDevice(kind, deviceId);
  }, []);

  const requestMute = useCallback(
    async (target: string, kind: 'audio' | 'video' = 'audio') => {
      await ajaxFetch(`/api/av/mute?${new URLSearchParams({ roomId }).toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'audio' ? { target } : { target, kind }),
      });
    },
    [roomId],
  );

  return useMemo<UseAvSessionResult>(
    () => ({
      status: state.status,
      error: state.error,
      local: state.local,
      participants: state.participants,
      devices: state.devices,
      unavailableReason,
      room,
      toggleMicrophone,
      toggleCamera,
      toggleScreenShare,
      selectDevice,
      requestMute,
      leave,
    }),
    [
      state.status,
      state.error,
      state.local,
      state.participants,
      state.devices,
      unavailableReason,
      room,
      toggleMicrophone,
      toggleCamera,
      toggleScreenShare,
      selectDevice,
      requestMute,
      leave,
    ],
  );
}



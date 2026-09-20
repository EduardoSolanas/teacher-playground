'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ajaxFetch } from '@/lib/http/ajaxFetch';
import type { Room } from 'livekit-client';
import type { LiveKitProvider } from '@/lib/av/livekitProvider';
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
  readonly local: { micMuted: boolean; camOn: boolean; isScreenSharing?: boolean; canScreenShare?: boolean | null };
  readonly participants: readonly ParticipantState[];
  readonly devices: Readonly<Record<DeviceKind, readonly AvDevice[]>>;
  readonly activeDevices: Readonly<Record<DeviceKind, string | undefined>>;
  readonly unavailableReason: 'unconfigured' | 'forbidden' | 'waiting' | null;
  /**
   * Whether this session's token allows publishing. False is a viewer, whose
   * mic and camera buttons could only ever fail; null means the grant could
   * not be read, which is treated as "allowed" so a decode quirk never locks
   * a teacher out of their own call.
   */
  readonly canPublish: boolean | null;
  readonly room: Room | null;
  readonly toggleMicrophone: () => void;
  readonly toggleCamera: () => void;
  readonly toggleScreenShare: () => Promise<void>;
  readonly selectDevice: (kind: DeviceKind, deviceId: string) => Promise<void>;
  readonly requestMute: (identity: string, kind?: 'audio' | 'video') => Promise<void>;
  /** Owner only: allow or withdraw one participant's screen share on this call. */
  readonly setScreenShareAllowed: (identity: string, allowed: boolean) => Promise<void>;
  /** Retry a failed join, or rejoin after the token or socket dropped it. */
  readonly retry: () => void;
  readonly leave: () => void;
}

/**
 * The publish grant, read from the LiveKit token's own payload.
 *
 * The endpoint does not echo the role, but it does not need to: the JWT is in
 * hand and its `video.canPublish` claim is the same one the media server will
 * enforce. The payload is not secret and this does not verify the signature --
 * it is a UI hint, and the server remains the authority. A token that cannot
 * be read returns null, which the UI treats as publishable rather than using a
 * parse failure to take away somebody's mic.
 */
export function readCanPublishFromToken(token: string): boolean | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded)) as { video?: { canPublish?: unknown } };
    const canPublish = decoded?.video?.canPublish;
    return typeof canPublish === 'boolean' ? canPublish : null;
  } catch {
    return null;
  }
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
  activeDevices: { microphone: undefined, camera: undefined, speaker: undefined },
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
  const [canPublish, setCanPublish] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
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
    setCanPublish(null);
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
        // Re-checked after the body, not just after the headers: the room can be
        // left, or A/V switched off, while the body is still arriving.
        if (cancelled) return;
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
      // Same reason as the 403 branch above, and it matters more here: the next
      // lines construct a provider and take the microphone.
      if (cancelled) return;
      if (!body.token || !body.url) {
        setUnavailableReason('unconfigured');
        return;
      }

      /*
       * The SDK is the heaviest module the room can load (PERF-S1), and this
       * is the only line that ever needs it: fetched alongside the token it
       * will spend, and only once a token exists to spend. A room that never
       * calls never downloads it.
       */
      const { LiveKitProvider: Provider } = await import('@/lib/av/livekitProvider');
      if (cancelled) return;

      const provider = new Provider();
      const session = createAvSession(provider);
      providerRef.current = provider;
      sessionRef.current = session;
      setSession(session);
      setRoom(provider.getRoom());
      setStartupError(null);
      setCanPublish(readCanPublishFromToken(body.token));
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
  }, [enabled, roomId, identity, leave, attempt]);

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
    const wasSharing = sessionRef.current?.local.isScreenSharing === true;
    await sessionRef.current?.toggleScreenShare();
    /*
     * An allowed share lasts one share (Phase 10): stopping it hands the
     * permission back, so the next one needs the owner again. The server acts
     * only on the caller and does nothing for the owner, whose share is theirs
     * by right. Best effort -- a lost request leaves the permission until the
     * participant rejoins, which mints a narrow token anyway.
     */
    if (wasSharing) {
      void ajaxFetch(`/api/whiteboard/room/${encodeURIComponent(roomId)}/av`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end-screen-share' }),
      }).catch(() => undefined);
    }
  }, [roomId]);

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

  const setScreenShareAllowed = useCallback(
    async (target: string, allowed: boolean) => {
      await ajaxFetch(`/api/whiteboard/room/${encodeURIComponent(roomId)}/av`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: allowed ? 'allow-screen-share' : 'revoke-screen-share',
          target,
        }),
      });
    },
    [roomId],
  );

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return useMemo<UseAvSessionResult>(
    () => ({
      status: state.status,
      error: state.error,
      local: state.local,
      participants: state.participants,
      devices: state.devices,
      activeDevices: state.activeDevices,
      unavailableReason,
      canPublish,
      room,
      toggleMicrophone,
      toggleCamera,
      toggleScreenShare,
      selectDevice,
      requestMute,
      setScreenShareAllowed,
      retry,
      leave,
    }),
    [
      state.status,
      state.error,
      state.local,
      state.participants,
      state.devices,
      state.activeDevices,
      unavailableReason,
      canPublish,
      room,
      toggleMicrophone,
      toggleCamera,
      toggleScreenShare,
      selectDevice,
      requestMute,
      setScreenShareAllowed,
      retry,
      leave,
    ],
  );
}



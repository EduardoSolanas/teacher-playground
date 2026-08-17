'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ajaxFetch } from '@/lib/http/ajaxFetch';
import {
  createAvSession,
  type AvError,
  type AvSession,
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
  readonly devices: Record<DeviceKind, string[]>;
  readonly unavailableReason: 'unconfigured' | 'forbidden' | 'waiting' | null;
  readonly toggleMicrophone: () => void;
  readonly selectDevice: (kind: DeviceKind, deviceId: string) => Promise<void>;
  readonly requestMute: (identity: string) => void;
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

function snapshot(session: AvSession) {
  return {
    status: session.status,
    error: session.error,
    local: { ...session.local },
    participants: [...session.participants],
    devices: {
      microphone: [...session.devices.microphone],
      camera: [...session.devices.camera],
    },
  };
}

/**
 * Fetches a short-lived LiveKit token and drives the voice session while the
 * caller is an admitted room participant. Disabled while waiting / kicked.
 */
export function useAvSession(options: UseAvSessionOptions): UseAvSessionResult {
  const { roomId, identity, displayName, enabled } = options;
  const sessionRef = useRef<AvSession | null>(null);
  const providerRef = useRef<LiveKitProvider | null>(null);
  const [state, setState] = useState(() => ({
    status: 'idle' as AvSessionStatus,
    error: null as AvError | null,
    local: { micMuted: false, camOn: false },
    participants: [] as ParticipantState[],
    devices: { microphone: [] as string[], camera: [] as string[] },
  }));
  const [unavailableReason, setUnavailableReason] = useState<
    'unconfigured' | 'forbidden' | 'waiting' | null
  >(null);

  const refresh = useCallback(() => {
    if (!sessionRef.current) return;
    setState(snapshot(sessionRef.current));
  }, []);

  const leave = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    providerRef.current = null;
    setUnavailableReason(null);
    setState({
      status: 'idle',
      error: null,
      local: { micMuted: false, camOn: false },
      participants: [],
      devices: { microphone: [], camera: [] },
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      leave();
      return;
    }
    if (!identity) return;

    let cancelled = false;
    let pollTimer: number | undefined;

    async function start() {
      const params = new URLSearchParams({
        roomId,
        identity,
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
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: { kind: 'unknown', message: `Token request failed (${response.status})` },
        }));
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
      setUnavailableReason(null);

      pollTimer = window.setInterval(() => {
        if (!cancelled) refresh();
      }, 250);

      await session.join(body.token, body.url);
      if (cancelled) {
        session.leave();
        return;
      }
      refresh();
    }

    void start();

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      leave();
    };
  }, [enabled, roomId, identity, displayName, leave, refresh]);

  useEffect(() => {
    const onPageHide = () => leave();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [leave]);

  return {
    status: state.status,
    error: state.error,
    local: state.local,
    participants: state.participants,
    devices: state.devices,
    unavailableReason,
    toggleMicrophone: () => {
      sessionRef.current?.toggleMicrophone();
      refresh();
    },
    selectDevice: async (kind, deviceId) => {
      await sessionRef.current?.selectDevice(kind, deviceId);
      refresh();
    },
    requestMute: (target) => {
      sessionRef.current?.requestMute(target);
      refresh();
    },
    attachTrack: (id, kind, el) => sessionRef.current?.attachTrack(id, kind, el),
    detachTrack: (id, kind, el) => sessionRef.current?.detachTrack(id, kind, el),
    leave,
  };
}

import {
  buildLiveKitRoomServiceToken,
  parseLiveKitConfig,
} from './livekitToken';

export interface RemoveLiveKitParticipantInput {
  readonly env: unknown;
  readonly roomId: string;
  readonly identity: string;
}

export type RemoveLiveKitParticipantResult =
  | { readonly ok: true; readonly skipped?: true }
  | { readonly ok: false; readonly status: number };

/** Converts a LiveKit WebSocket URL to the HTTPS host used by Room Service APIs. */
export function liveKitHttpHost(liveKitUrl: string): string {
  try {
    const parsed = new URL(liveKitUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else return liveKitUrl;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return liveKitUrl;
  }
}

/**
 * Removes a participant from a LiveKit room via the Room Service HTTP API.
 *
 * When LiveKit is unconfigured, returns a no-op success so callers are not
 * blocked. Network and HTTP failures return `{ ok: false, status }` without
 * throwing.
 */
export async function removeLiveKitParticipant(
  input: RemoveLiveKitParticipantInput,
): Promise<RemoveLiveKitParticipantResult> {
  const config = parseLiveKitConfig(input.env);
  if (!config) {
    return { ok: true, skipped: true };
  }

  const host = liveKitHttpHost(config.url);
  const url = `${host}/twirp/livekit.RoomService/RemoveParticipant`;

  try {
    const token = await buildLiveKitRoomServiceToken({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      room: input.roomId,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room: input.roomId,
        identity: input.identity,
      }),
    });

    if (response.status === 200) {
      return { ok: true };
    }
    return { ok: false, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export interface MuteLiveKitParticipantInput {
  readonly env: unknown;
  readonly roomId: string;
  readonly identity: string;
}

export type MuteLiveKitParticipantResult =
  | { readonly ok: true; readonly skipped?: true }
  | { readonly ok: false; readonly status: number };

/**
 * Mutes a participant's audio track in a LiveKit room via the Room Service HTTP API.
 *
 * When LiveKit is unconfigured, returns a no-op success so callers are not
 * blocked. If the participant has no audio track, returns skipped. Network and
 * HTTP failures return `{ ok: false, status }` without throwing.
 */
export async function muteLiveKitParticipant(
  input: MuteLiveKitParticipantInput,
): Promise<MuteLiveKitParticipantResult> {
  const config = parseLiveKitConfig(input.env);
  if (!config) {
    return { ok: true, skipped: true };
  }

  const host = liveKitHttpHost(config.url);
  const getParticipantUrl = `${host}/twirp/livekit.RoomService/GetParticipant`;

  try {
    const token = await buildLiveKitRoomServiceToken({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      room: input.roomId,
    });

    // First call: GetParticipant to find the audio track
    const getResponse = await fetch(getParticipantUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room: input.roomId,
        identity: input.identity,
      }),
    });

    if (getResponse.status !== 200) {
      return { ok: false, status: getResponse.status };
    }

    const getResponseJson = await getResponse.json() as {
      participant?: {
        tracks?: Array<{ sid: string; type?: string; source?: string }>;
      };
    };

    // Find first audio track
    const audioTrack = (getResponseJson.participant?.tracks ?? []).find(
      (track) => track.type === 'AUDIO' || track.source === 'MICROPHONE',
    );

    if (!audioTrack) {
      return { ok: true, skipped: true };
    }

    // Second call: MutePublishedTrack
    const muteUrl = `${host}/twirp/livekit.RoomService/MutePublishedTrack`;
    const muteResponse = await fetch(muteUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room: input.roomId,
        identity: input.identity,
        track_sid: audioTrack.sid,
        muted: true,
      }),
    });

    if (muteResponse.status === 200) {
      return { ok: true };
    }
    return { ok: false, status: muteResponse.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

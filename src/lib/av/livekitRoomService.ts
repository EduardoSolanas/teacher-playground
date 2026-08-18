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
  if (liveKitUrl.startsWith('wss://')) {
    return `https://${liveKitUrl.slice('wss://'.length)}`;
  }
  if (liveKitUrl.startsWith('ws://')) {
    return `http://${liveKitUrl.slice('ws://'.length)}`;
  }
  return liveKitUrl;
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

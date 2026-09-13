/*
 * LiveKit's TrackSource wire values (livekit_models.proto: UNKNOWN 0, CAMERA 1,
 * MICROPHONE 2, SCREEN_SHARE 3, SCREEN_SHARE_AUDIO 4). Stated here because the
 * enum lives in @livekit/protocol, which this application only has as a
 * transitive dependency of livekit-client.
 */
export const TRACK_SOURCE_SCREEN_SHARE = 3;

/** The part of a LiveKit participant's permissions that decides screen share. */
export interface PublishPermission {
  readonly canPublish: boolean;
  readonly canPublishSources: readonly number[];
}

/**
 * Whether a participant may publish their screen right now.
 *
 * Mirrors the media server's rule, so the button agrees with what LiveKit will
 * accept: a participant who cannot publish never shares, an empty allowlist
 * means every source, and otherwise the allowlist must name the screen. The
 * owner's token has no allowlist; everyone else's names camera and microphone
 * until the owner allows a share on the live call (Phase 10).
 *
 * `null` when the permissions have not arrived yet, which is not a refusal.
 */
export function mayShareScreen(permissions: PublishPermission | undefined): boolean | null {
  if (!permissions) return null;
  if (!permissions.canPublish) return false;
  if (permissions.canPublishSources.length === 0) return true;
  return permissions.canPublishSources.includes(TRACK_SOURCE_SCREEN_SHARE);
}

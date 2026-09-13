import { describe, expect, it } from 'vitest';
import { mayShareScreen, TRACK_SOURCE_SCREEN_SHARE } from './screenSharePermission';

const CAMERA = 1;
const MICROPHONE = 2;

describe('mayShareScreen', () => {
  it("pins the screen source to LiveKit's wire value", () => {
    expect(TRACK_SOURCE_SCREEN_SHARE).toBe(3);
  });

  it('follows LiveKit: no source allowlist means every source a publisher has', () => {
    expect(mayShareScreen({ canPublish: true, canPublishSources: [] })).toBe(true);
  });

  it('allows a screen only when the allowlist names it', () => {
    expect(mayShareScreen({
      canPublish: true,
      canPublishSources: [CAMERA, MICROPHONE],
    })).toBe(false);
    expect(mayShareScreen({
      canPublish: true,
      canPublishSources: [CAMERA, MICROPHONE, TRACK_SOURCE_SCREEN_SHARE],
    })).toBe(true);
  });

  it('never lets a participant who cannot publish share, allowlist or not', () => {
    expect(mayShareScreen({ canPublish: false, canPublishSources: [] })).toBe(false);
    expect(mayShareScreen({ canPublish: false, canPublishSources: [TRACK_SOURCE_SCREEN_SHARE] })).toBe(false);
  });

  it('treats a participant whose permissions have not arrived yet as unknown, not refused', () => {
    // Before the join completes the SDK has no permission object; the button
    // is inert then anyway, and refusing would flash "not allowed" at the owner.
    expect(mayShareScreen(undefined)).toBeNull();
  });
});

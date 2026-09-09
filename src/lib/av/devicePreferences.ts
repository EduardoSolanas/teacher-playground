/**
 * Device preference persistence.
 *
 * Remembers which microphone, camera, and speaker the user last chose, so that
 * a device selection carries across calls and app reloads.
 *
 * All reads and writes are wrapped in try/catch so that storage unavailability
 * (private windows, blocked site data, or app-level permission denial) does not
 * break a call — the app simply treats an unavailable device as "no preference."
 */

import type { DeviceKind } from './avSession';

const KEY_PREFIX = 'whiteboard_call_device_';

function getStorageKey(kind: DeviceKind): string {
  return `${KEY_PREFIX}${kind}`;
}

/**
 * Read a stored device preference for the given kind.
 * Returns undefined if no preference is stored or if storage is unavailable.
 */
export function readDevicePreference(kind: DeviceKind): string | undefined {
  try {
    const stored = localStorage.getItem(getStorageKey(kind));
    return stored ?? undefined;
  } catch {
    // Storage access denied (private window, permissions, etc.)
    return undefined;
  }
}

/**
 * Write a device preference for the given kind.
 * Silently degrades if storage is unavailable.
 */
export function writeDevicePreference(kind: DeviceKind, deviceId: string): void {
  try {
    localStorage.setItem(getStorageKey(kind), deviceId);
  } catch {
    // Storage access denied; best effort
  }
}

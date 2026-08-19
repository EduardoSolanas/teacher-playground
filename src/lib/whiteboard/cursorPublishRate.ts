/**
 * Cursor positions are published into the shared document, and every write
 * becomes one signaling message. A pointer moving at screen refresh rate emits
 * more than the Worker's 60 messages/second cap, which closes the socket with
 * 1008 and drops the user back to "Connecting to room…". Publishing on an
 * interval keeps a moving pointer well inside that budget.
 */
export const CURSOR_PUBLISH_INTERVAL_MS = 50;

/** Milliseconds to wait before the next cursor publish; 0 means publish now. */
export function cursorPublishDelay(
  lastPublishedAt: number | null,
  now: number,
  intervalMs: number = CURSOR_PUBLISH_INTERVAL_MS,
): number {
  if (lastPublishedAt === null) return 0;
  const elapsed = now - lastPublishedAt;
  if (elapsed >= intervalMs) return 0;
  // A backwards clock jump must not stretch the wait past one interval.
  return Math.min(intervalMs, intervalMs - elapsed);
}

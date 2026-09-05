export const IMAGE_RETRY_DELAY_MS = 3000;
export const IMAGE_MAX_RETRIES = 5;

export type MissingImageEntry = { at: number; retries: number };

export function shouldRetryMissingImage(
  entry: MissingImageEntry | undefined,
  now: number,
): boolean {
  if (!entry) return true; // never seen, fetch it
  if (entry.retries >= IMAGE_MAX_RETRIES) return false; // gave up
  return now - entry.at >= IMAGE_RETRY_DELAY_MS; // wait between retries
}

export function recordMissing(
  existing: MissingImageEntry | undefined,
  now: number,
): MissingImageEntry {
  return { at: now, retries: (existing?.retries ?? 0) + 1 };
}

/**
 * Pure update rule for the server's stored page-state map
 * (spec/PAGED_DOCUMENTS_SPEC.md §5.2): a capped, insertion-ordered list of
 * `{ importId, index }` entries persisted under storage key
 * `documents:pages`. Kept apart from `RoomDO` so the capping and
 * re-insertion rule can be tested without a Durable Object.
 */
import type { PageMessage } from './pageMessage';

/** The map holds at most this many entries (spec §5.2). */
export const MAX_STORED_PAGE_ENTRIES = 200;

/**
 * Sets `importId -> index`, insertion-ordered: a new key is appended, an
 * existing key is moved to the end (spec §5.2, "re-setting an existing key
 * moves it to the end"). When the result would exceed `cap`, the oldest
 * entry -- the one least recently set, never the one just set -- is dropped.
 */
export function withPageEntry(
  entries: readonly PageMessage[],
  message: PageMessage,
  cap: number = MAX_STORED_PAGE_ENTRIES,
): readonly PageMessage[] {
  const next = entries.filter((entry) => entry.importId !== message.importId);
  next.push(message);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

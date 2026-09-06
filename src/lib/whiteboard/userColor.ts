export const USER_COLORS = [
  '#e74c3c',
  '#e67e22',
  '#f1c40f',
  '#2ecc71',
  '#3498db',
  '#9b59b6',
  '#1abc9c',
  '#e91e63',
  '#607d8b',
  '#ff6b6b',
] as const;

export const USER_COLOR_STORAGE_KEY = 'whiteboard_user_color';

/** Fallback when there is no name and nothing stored. */
export const DEFAULT_USER_COLOR = '#3498db';

/**
 * A stable colour for a name.
 *
 * Same name, same colour, on every device and in every room: the colour is not
 * stored anywhere shared, so it has to be derivable rather than allocated.
 */
export function generateUserColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

/**
 * The colour this browser last saved, or one derived from the name.
 *
 * Both halves matter. The stored value keeps a person the same colour after
 * they rename, and the derived fallback covers a browser that never stored one
 * -- a guest, a cleared profile, or storage being unavailable, which throws
 * from the getter rather than returning null.
 */
export function resolveUserColor(name: string): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem(USER_COLOR_STORAGE_KEY);
      if (stored) return stored;
    } catch {
      // Storage unavailable; fall through to the derived colour.
    }
  }
  return name ? generateUserColor(name) : DEFAULT_USER_COLOR;
}

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

const DARK_FOREGROUND = '#0f172a';
const LIGHT_FOREGROUND = '#ffffff';

/** WCAG 2.x relative luminance, or null when the input is not a hex colour. */
function relativeLuminance(color: string): number | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : match[1];
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The foreground that reads best on a user colour.
 *
 * Avatar initials used to be unconditionally white, which fails WCAG AA on
 * most of the palette -- yellow is 1.66:1. Pick whichever of the two house
 * foregrounds has the higher contrast ratio, and fall back to white when the
 * colour cannot be parsed so an unknown value never renders dark-on-dark.
 */
export function contrastTextOn(backgroundColor: string): '#ffffff' | '#0f172a' {
  const background = relativeLuminance(backgroundColor);
  if (background === null) return LIGHT_FOREGROUND;
  const onDark = contrastRatio(background, relativeLuminance(DARK_FOREGROUND)!);
  const onLight = contrastRatio(background, relativeLuminance(LIGHT_FOREGROUND)!);
  return onDark >= onLight ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

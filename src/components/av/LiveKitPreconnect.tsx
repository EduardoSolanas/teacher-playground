/*
 * PERF-S5: a preconnect hint for the LiveKit edge origin, rendered on the
 * room route.
 *
 * The room talks to exactly one cross-origin host: the LiveKit edge the
 * media websocket dials. Its TLS+TCP handshake can start while the room is
 * still loading, so the first token fetch and the socket connect meet a warm
 * connection instead of a cold one. The signaling socket is same-origin
 * (/signaling) -- a page is already connected to its own origin, so hinting
 * for it would be a no-op and there is none.
 *
 * The client cannot know the LiveKit origin before the token response hands
 * it over, and a same-document <link> can only hint origins known at render
 * time. So the hint is honest only when the deployment tells the client the
 * origin at build time: set NEXT_PUBLIC_LIVEKIT_HINT to the same value as
 * the server's LIVEKIT_URL (Next inlines NEXT_PUBLIC_* into the exported
 * HTML). Unset -- the default -- renders nothing, and no origin is guessed.
 *
 * Server-safe on purpose: no 'use client', no hooks. It renders once into
 * the room route's layout and links hoist to <head> in the exported HTML.
 */

/** LiveKit origins arrive as wss:// or https://; anything else is refused. */
export function liveKitPreconnectHref(hint: string | undefined | null): string | null {
  if (typeof hint !== 'string') return null;
  const trimmed = hint.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'wss:' && url.protocol !== 'https:') return null;
    return `https://${url.host}`;
  } catch {
    return null;
  }
}

export default function LiveKitPreconnect() {
  const href = liveKitPreconnectHref(process.env.NEXT_PUBLIC_LIVEKIT_HINT);
  if (!href) return null;
  return (
    <link
      rel="preconnect"
      href={href}
      /*
       * The media socket is not credentialed, so the connection the browser
       * opens must be the anonymous one for the socket to reuse it.
       */
      crossOrigin="anonymous"
      data-testid="livekit-preconnect"
    />
  );
}

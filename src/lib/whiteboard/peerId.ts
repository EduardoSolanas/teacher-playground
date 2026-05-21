/** Stable per-room peer id (survives refresh) for collaboration and host assignment. */
export function getStablePeerId(roomId: string) {
  const fallback = `user-${Math.random().toString(36).substring(2, 9)}`;
  if (typeof window === 'undefined') return fallback;

  try {
    const key = `whiteboard:${roomId}:peer_id`;
    const saved = localStorage.getItem(key);
    if (saved) return saved;

    localStorage.setItem(key, fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

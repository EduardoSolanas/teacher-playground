type ProviderConnection = {
  connected?: boolean;
  wsconnected?: boolean;
  synced?: boolean;
};

export function isYjsProviderConnected(provider: ProviderConnection | null | undefined): boolean {
  if (!provider) return false;
  return Boolean(provider.wsconnected ?? provider.connected);
}

/**
 * HTTP snapshot catch-up runs unless the live document is connected and synced.
 *
 * A peer the room has not granted is out of it entirely. The board is refused
 * for them -- 401 before a session exists, 403 while they are still in the
 * waiting room -- and a refusal is not something the catch-up can act on, so
 * asking twice a second buys nothing and fills the console. Admission re-runs
 * the room load, which is what turns the poll back on.
 */
export function shouldPollRoomApiFallback(
  provider: ProviderConnection | null | undefined,
  roomGranted: boolean,
): boolean {
  if (!roomGranted) return false;
  if (!isYjsProviderConnected(provider)) return true;
  return !Boolean(provider?.synced);
}

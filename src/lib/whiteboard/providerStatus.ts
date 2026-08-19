type ProviderConnection = {
  connected?: boolean;
  wsconnected?: boolean;
  synced?: boolean;
};

export function isYjsProviderConnected(provider: ProviderConnection | null | undefined): boolean {
  if (!provider) return false;
  return Boolean(provider.wsconnected ?? provider.connected);
}

/** HTTP snapshot catch-up runs unless the live document is connected and synced. */
export function shouldPollRoomApiFallback(provider: ProviderConnection | null | undefined): boolean {
  if (!isYjsProviderConnected(provider)) return true;
  return !Boolean(provider?.synced);
}

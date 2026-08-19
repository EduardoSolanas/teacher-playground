/** Full-screen “connecting” chrome must not cover a board that is already up. */
export function shouldOverlayConnectingScreen(input: {
  boardEverShown: boolean;
  isSynced: boolean;
}): boolean {
  return !input.isSynced && !input.boardEverShown;
}

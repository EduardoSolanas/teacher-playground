export const AFTER_LOGOUT_PATH = '/';

export async function completeSignOut(options: {
  logout: () => Promise<unknown>;
  navigate: (path: string) => void;
}): Promise<void> {
  try {
    await options.logout();
  } catch {
    // Leave the whiteboard even if session revoke fails.
  }
  options.navigate(AFTER_LOGOUT_PATH);
}

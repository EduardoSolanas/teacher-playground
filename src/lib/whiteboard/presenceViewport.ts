/** Collapse the roster only on a known phone-width viewport. */
export function shouldCollapsePresenceForViewport(width: number): boolean {
  return width > 0 && width < 640;
}

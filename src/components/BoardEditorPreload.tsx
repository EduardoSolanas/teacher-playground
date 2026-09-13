'use client';

/*
 * The board editor starts downloading here, not at first mount.
 *
 * The room's component tree only starts mounting once AccessSessionBootstrap
 * has fetched the session and the room read has come back, so anything the
 * room imports waits behind those round trips -- and the editor bundle, the
 * heaviest download of the whole load, arrived last. Importing it from this
 * module hands the request to the network while those round trips are still
 * in flight; the wrapper's own dynamic import later resolves against the same
 * chunks, so nothing is fetched twice.
 *
 * This module has to be rendered (not merely imported) for its side effect to
 * run: a client module imported only for side effects by a server component
 * is listed in the build manifest but nothing on the client ever requires it.
 *
 * Room route only. `/whiteboard` is the rooms list and does not use the
 * editor, and the module evaluates once per document load, so a teacher
 * browsing rooms never pays for the bundle. A client-side navigation from the
 * list into a room re-uses the already-evaluated module and so keeps the old
 * mount-time behaviour; the document load path is the one this closes.
 *
 * Guarded against Node (the static export evaluates this module while
 * prerendering) and against the unit suites (jsdom), which import room code
 * and have no reason to pull in the editor bundle. In production neither
 * guard is true.
 */
if (
  typeof window !== 'undefined'
  && process.env.VITEST === undefined
  && /^\/whiteboard\/[^/]+\/?$/.test(window.location.pathname)
) {
  void import('@/components/whiteboard/ExcalidrawWrapper');
}

/** Renders nothing; the import above is the point. */
export default function BoardEditorPreload() {
  return null;
}

import type { Viewport } from 'next';
import RoomClient from './RoomClient';

/*
 * The board owns two-finger pinch, so the page must not.
 *
 * iOS browsers other than Safari are WKWebViews, which honour these limits. On
 * a page that can still be zoomed, the web view's own pinch recogniser claims
 * the gesture and cancels the pointers before the canvas sees it, and nothing
 * zooms at all. Excalidraw's own app pins the scale for the same reason. The
 * board's zoom stands in for the page's; the rooms list is a document and
 * keeps the root layout's zoomable viewport.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

// Room ids are created at runtime, so none can be enumerated at build time.
// A single placeholder page is exported and the Worker serves it for every
// /whiteboard/<roomId> URL; RoomClient reads the real id from the path.
export function generateStaticParams() {
  return [{ roomId: '_room' }];
}

export default function WhiteboardRoomPage() {
  return <RoomClient />;
}

import RoomClient from './RoomClient';

// Room ids are created at runtime, so none can be enumerated at build time.
// A single placeholder page is exported and the Worker serves it for every
// /whiteboard/<roomId> URL; RoomClient reads the real id from the path.
export function generateStaticParams() {
  return [{ roomId: '_room' }];
}

export default function WhiteboardRoomPage() {
  return <RoomClient />;
}

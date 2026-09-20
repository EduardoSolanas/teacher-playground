import LiveKitPreconnect from "../../../components/av/LiveKitPreconnect";

/*
 * The room route's own layout. `/whiteboard` (the rooms list) shares the
 * whiteboard layout above this one but not this: only a room dials the
 * LiveKit edge, so only the room carries its preconnect hint. Nothing is
 * rendered when no origin is configured (PERF-S5, LiveKitPreconnect).
 */
export default function WhiteboardRoomLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <LiveKitPreconnect />
      {children}
    </>
  );
}

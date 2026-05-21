import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type Konva from 'konva';
import type { RemoteCursor } from '@/types/whiteboard';
import * as store from '@/lib/whiteboard/store';
import { canvasPointToOverlay } from '@/components/whiteboard/tools/pointer';

export default function RemoteCursors({
  cursors,
  localPeerId,
  stageRef,
}: {
  cursors: RemoteCursor[];
  localPeerId: string;
  stageRef?: RefObject<Konva.Stage | null>;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [renderData, setRenderData] = useState<
    { peerId: string; x: number; y: number; color: string; userName: string }[]
  >([]);

  const remotePeers = useMemo(
    () => cursors.filter((c) => c.peerId !== localPeerId),
    [cursors, localPeerId],
  );

  useLayoutEffect(() => {
    const vp = store.getState().viewport;
    const stageContainer = stageRef?.current?.container() ?? null;

    setRenderData(
      remotePeers.map((c) => {
        const pos = canvasPointToOverlay(
          c.x,
          c.y,
          vp,
          stageContainer,
          overlayRef.current,
        );
        return {
          peerId: c.peerId,
          x: pos.x,
          y: pos.y,
          color: c.color,
          userName: c.userName,
        };
      }),
    );
  }, [remotePeers, stageRef]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const vp = store.getState().viewport;
      const stageContainer = stageRef?.current?.container() ?? null;
      setRenderData(
        remotePeers.map((c) => {
          const pos = canvasPointToOverlay(
            c.x,
            c.y,
            vp,
            stageContainer,
            overlayRef.current,
          );
          return {
            peerId: c.peerId,
            x: pos.x,
            y: pos.y,
            color: c.color,
            userName: c.userName,
          };
        }),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [remotePeers, stageRef]);

  if (renderData.length === 0) return null;

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0 z-[90]"
      data-testid="whiteboard-remote-cursors"
    >
      {renderData.map((cursor) => (
        <div
          key={cursor.peerId}
          className="absolute"
          style={{
            left: cursor.x,
            top: cursor.y,
            transform: 'translate(-2px, -2px)',
            transition: 'left 80ms linear, top 80ms linear',
          }}
        >
          <svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden>
            <path
              d="M0 0L14.5 14.5L9 24L7 18L14 18L0 0Z"
              fill={cursor.color}
              stroke="#fff"
              strokeWidth="1.5"
            />
          </svg>
          <span
            className="block whitespace-nowrap text-[11px] font-semibold text-white"
            style={{
              marginLeft: 16,
              marginTop: -18,
              background: cursor.color,
              padding: '2px 6px',
              borderRadius: 4,
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }}
          >
            {cursor.userName}
          </span>
        </div>
      ))}
    </div>
  );
}

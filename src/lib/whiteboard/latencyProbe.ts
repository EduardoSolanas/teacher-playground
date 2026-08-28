export type WhiteboardLatencyEventKind =
  | 'stroke-publish'
  | 'stroke-render'
  | 'cursor-publish'
  | 'cursor-render';

export interface WhiteboardLatencyEvent {
  kind: WhiteboardLatencyEventKind;
  at: number;
  elementId?: string;
  version?: number;
  peerId?: string;
  x?: number;
  y?: number;
}

export type WhiteboardLatencyEventInput = Omit<WhiteboardLatencyEvent, 'at'>;

const MAX_EVENTS = 1000;

declare global {
  interface Window {
    __whiteboardLatencyEvents?: WhiteboardLatencyEvent[];
  }
}

export function isWhiteboardLatencyProbeEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_E2E === '1';
}

export function isWhiteboardIncrementSyncEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WHITEBOARD_INCREMENTS === '1';
}

export function isWhiteboardIncrementComparisonEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WHITEBOARD_INCREMENT_COMPARE === '1';
}

function browserWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

export function recordWhiteboardLatencyEvent(
  input: WhiteboardLatencyEventInput,
  now?: number,
): void {
  const target = browserWindow();
  if (!target || !isWhiteboardLatencyProbeEnabled()) return;

  const events = target.__whiteboardLatencyEvents ?? (target.__whiteboardLatencyEvents = []);
  events.push({ ...input, at: now ?? Date.now() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function readWhiteboardLatencyEvents(): WhiteboardLatencyEvent[] {
  const target = browserWindow();
  if (!target || !isWhiteboardLatencyProbeEnabled()) return [];

  return (target.__whiteboardLatencyEvents ?? []).map((event) => ({ ...event }));
}

export function clearWhiteboardLatencyEvents(): void {
  const target = browserWindow();
  if (!target || !isWhiteboardLatencyProbeEnabled()) return;

  target.__whiteboardLatencyEvents = [];
}

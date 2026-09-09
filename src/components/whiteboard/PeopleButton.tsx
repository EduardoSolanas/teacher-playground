'use client';

import type { WhiteboardUser } from '@/types/whiteboard';
import { RaisedHandIcon } from './RaisedHandCue';

/**
 * Opens the room's participant list.
 *
 * Top right, showing stacked faces and a count -- where Lessonspace and Pencil
 * Spaces both put it. The roster used to be docked open beside the call rail,
 * which put two permanent panels on the same edge and drew everybody's mic and
 * camera state twice: once on their tile, once on their row. Both products keep
 * only the tiles on screen and put the participant list behind this.
 */
export default function PeopleButton({
  users,
  waitingCount = 0,
  capacity,
  expanded,
  onToggle,
  anyHandRaised,
}: {
  readonly users: readonly WhiteboardUser[];
  readonly waitingCount?: number;
  readonly capacity?: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly anyHandRaised?: boolean;
}) {
  const shown = users.slice(0, 3);
  const label = capacity
    ? `People in the room, ${users.length} of ${capacity}`
    : `People in the room, ${users.length}`;
  const labelParts = [
    label,
    ...(waitingCount > 0 ? [`${waitingCount} waiting`] : []),
    ...(anyHandRaised ? ['hand raised'] : []),
  ];

  return (
    <button
      type="button"
      data-testid="whiteboard-people-button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={labelParts.join(', ')}
      title={label}
      className="relative inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-800 py-1 pl-1 pr-2.5 text-slate-100 transition-colors hover:border-slate-400 hover:bg-slate-700"
    >
      <span className="flex -space-x-1.5">
        {shown.map((user) => (
          <span
            key={user.peerId}
            aria-hidden
            style={{ borderColor: user.color }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 bg-slate-900 text-[0.625rem] font-semibold uppercase text-slate-100"
          >
            {(user.userName || '?').trim().slice(0, 1)}
          </span>
        ))}
      </span>
      <span className="text-[0.75rem] font-semibold tabular-nums">
        {capacity ? `${users.length}/${capacity}` : users.length}
      </span>
      {waitingCount > 0 && (
        <span
          data-testid="whiteboard-people-waiting-badge"
          aria-hidden
          className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[0.625rem] font-bold text-slate-950"
        >
          {waitingCount}
        </span>
      )}
      {anyHandRaised && (
        <RaisedHandIcon className="h-4 w-4" tone="ink" />
      )}
    </button>
  );
}

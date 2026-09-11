'use client';

import { useCallback, useEffect, useState } from 'react';
import { generateRoomId } from '@/lib/crypto/randomId';
import { navigateToWhiteboardRoom } from '@/lib/whiteboard/roomPath';
import { getStablePeerId } from '@/lib/whiteboard/peerId';
import { ajaxFetch } from '@/lib/http/ajaxFetch';
import TeacherRoomList from '@/components/whiteboard/TeacherRoomList';
import { supportEmail } from '@/components/whiteboard/SupportButton';
import {
  createTeacherRoom,
  deleteTeacherRoom,
  loadTeacherRooms,
  type AjaxFetch,
  type TeacherRoomSummary,
} from '@/lib/whiteboard/teacherRooms';
import {
  DEFAULT_MAX_USERS,
  FREE_MAX_ROOMS,
  FREE_MAX_USERS,
  MIN_MAX_USERS,
} from '@/lib/plan/limits';

const MIN_USERS = MIN_MAX_USERS;
const MAX_USERS = FREE_MAX_USERS;

/**
 * The room list and the create form.
 *
 * Split out of the route so it can be rendered without the profile menu and
 * its router, and so the HTTP calls can be injected: the tests drive it with
 * real `Response` objects from a plain function instead of a stubbed fetch.
 */
export default function TeacherRoomsPanel({
  request = ajaxFetch,
  onOpen = navigateToWhiteboardRoom,
}: {
  request?: AjaxFetch;
  onOpen?: (roomId: string) => void;
} = {}) {
  const [maxUsers, setMaxUsers] = useState(DEFAULT_MAX_USERS);
  const [newRoomName, setNewRoomName] = useState('');
  const [creationTimes, setCreationTimes] = useState<number[]>([]);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<TeacherRoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomsError, setRoomsError] = useState(false);

  const loadRooms = useCallback(async () => {
    setRoomsLoading(true);
    setRoomsError(false);
    const parsed = await loadTeacherRooms(request);
    if (parsed === null) {
      setRoomsError(true);
    } else {
      setRooms(parsed);
    }
    setRoomsLoading(false);
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const parsed = await loadTeacherRooms(request);
      if (cancelled) return;
      if (parsed === null) {
        setRoomsError(true);
      } else {
        setRooms(parsed);
      }
      setRoomsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  const atRoomLimit = !roomsLoading && !roomsError && rooms.length >= FREE_MAX_ROOMS;
  const createDisabled = isCreatingRoom || roomsLoading || roomsError || atRoomLimit;
  // The link-and-PIN model is the one thing a new teacher has to know, and it
  // is only worth saying while there is nothing on the page demonstrating it.
  const showFirstRunHint = !roomsLoading && !roomsError && rooms.length === 0;

  const handleCreateRoom = useCallback(async () => {
    if (createDisabled) return;

    const now = Date.now();
    const recent = creationTimes.filter(t => now - t < 60000);
    if (recent.length >= 10) {
      setCreateError('Too many rooms created. Please wait a minute and try again.');
      return;
    }

    setCreateError(null);
    setIsCreatingRoom(true);
    const roomId = generateRoomId();
    const hostPeerId = getStablePeerId(roomId);

    try {
      const outcome = await createTeacherRoom({
        request,
        roomId,
        hostPeerId,
        maxUsers,
        ...(newRoomName.trim() ? { name: newRoomName.trim() } : {}),
      });
      if (!outcome.ok) {
        setCreateError(outcome.message);
        return;
      }
      // Only a creation that finished counts against the local burst guard.
      // A failure has not consumed the server's room or the teacher's
      // patience, and charging it would lock them out after ten attempts.
      setCreationTimes([...recent, now]);
      onOpen(roomId);
    } finally {
      setIsCreatingRoom(false);
    }
  }, [createDisabled, creationTimes, maxUsers, newRoomName, onOpen, request]);

  const refreshRooms = useCallback(async () => {
    const parsed = await loadTeacherRooms(request);
    if (parsed === null) {
      setRoomsError(true);
      return;
    }
    setRooms(parsed);
    setRoomsError(false);
  }, [request]);

  const handleRename = useCallback(
    async (roomId: string, nextName: string) => {
      try {
        const response = await request(`/api/whiteboard/room/${roomId}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nextName }),
        });
        if (!response.ok) return false;
        await refreshRooms();
        return true;
      } catch {
        return false;
      }
    },
    [refreshRooms, request],
  );

  const handleDelete = useCallback(
    async (roomId: string) => {
      setDeleteError(null);
      try {
        const response = await deleteTeacherRoom(request, roomId);
        if (!response.ok) {
          setDeleteError('Could not delete that room. Try again.');
          return;
        }
        await refreshRooms();
      } catch {
        setDeleteError('Could not delete that room. Try again.');
      }
    },
    [refreshRooms, request],
  );

  const stepUsers = (delta: number) =>
    setMaxUsers((current) => Math.max(MIN_USERS, Math.min(MAX_USERS, current + delta)));

  return (
    <>
      <div className="mt-6">
        {showFirstRunHint && (
          <p data-testid="whiteboard-first-run-hint" className="app-small">
            New here? Create a room, then share its join link or class PIN with your students.
          </p>
        )}
        <TeacherRoomList
          rooms={rooms}
          loading={roomsLoading}
          error={roomsError}
          onRetry={loadRooms}
          onOpen={onOpen}
          onRename={handleRename}
          onDelete={handleDelete}
          request={request}
        />
        {deleteError && (
          <p
            role="alert"
            data-testid="whiteboard-room-delete-error"
            className="app-error"
          >
            {deleteError}
          </p>
        )}

        {/*
          * The list page is where a teacher who cannot get a room working
          * stands; the room's "?" pill only exists inside a room, which is
          * exactly where somebody stuck outside a room cannot get to.
          */}
        {supportEmail() && (
          <p className="app-small">
            Need a hand?{' '}
            <a
              data-testid="whiteboard-rooms-support"
              href={`mailto:${supportEmail()}`}
              className="font-semibold text-[var(--blue)] underline"
            >
              Contact support
            </a>
          </p>
        )}
      </div>

      <div className="section-sep">
        <h2 className="app-h2">New room</h2>

        <form
          data-testid="whiteboard-new-room-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateRoom();
          }}
        >
        <div className="form-panel">
        <div className="field-group">
          <label htmlFor="whiteboard-room-name" className="app-label">
            Room name <span className="app-small">(optional)</span>
          </label>
          <input
            id="whiteboard-room-name"
            data-testid="whiteboard-new-room-name"
            type="text"
            value={newRoomName}
            maxLength={100}
            placeholder="Leave blank and name it later"
            onChange={(event) => setNewRoomName(event.target.value)}
            className="field-input nudge-top"
          />
        </div>

        <div className="field-group">
          <label
            htmlFor="whiteboard-max-users"
            className="app-label"
          >
            People allowed
          </label>
          <div className="stepper">
            <button
              type="button"
              aria-label="Fewer people"
              onClick={() => stepUsers(-1)}
              disabled={maxUsers <= MIN_USERS}
              className="stepper-btn"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M5 12h14" />
              </svg>
            </button>
            <input
              id="whiteboard-max-users"
              type="number"
              min={MIN_USERS}
              max={MAX_USERS}
              value={maxUsers}
              onChange={(e) =>
                setMaxUsers(
                  Math.max(MIN_USERS, Math.min(MAX_USERS, Number(e.target.value) || MIN_USERS)),
                )
              }
              className="stepper-input [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <button
              type="button"
              aria-label="More people"
              onClick={() => stepUsers(1)}
              disabled={maxUsers >= MAX_USERS}
              className="stepper-btn"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <p data-testid="whiteboard-free-plan-note" className="app-small">
            Includes you. Free accounts allow one room with one student.
          </p>
        </div>
        </div>

        {(createError || atRoomLimit) && (
          <p
            role="alert"
            data-testid="whiteboard-create-room-error"
            className="callout app-error"
          >
            {createError
              ?? 'Free accounts can keep one room. Delete it to create another.'}
          </p>
        )}

        <button
          type="submit"
          data-testid="whiteboard-create-room-btn"
          disabled={createDisabled}
          aria-busy={isCreatingRoom}
          className="btn btn-block"
        >
          {isCreatingRoom && (
            <span aria-hidden="true" className="spinner" />
          )}
          {isCreatingRoom ? 'Creating room...' : 'Create Room'}
        </button>
        </form>
      </div>
    </>
  );
}

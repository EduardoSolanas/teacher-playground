import { describe, expect, it } from 'vitest';
import type { SocketId } from '@excalidraw/excalidraw/types';
import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';
import { collaboratorsFromPresence } from './collaborators';

const users: WhiteboardUser[] = [
  {
    peerId: 'local',
    userName: 'Me',
    color: '#000000',
    isHost: false,
  },
  {
    peerId: 'host',
    userName: 'Name',
    color: '#112233',
    isHost: true,
  },
  {
    peerId: 'student',
    userName: 'Student',
    color: '#445566',
    isHost: false,
  },
];

const cursors: RemoteCursor[] = [
  {
    peerId: 'host',
    userName: 'Name',
    color: '#abcdef',
    x: 12,
    y: 34,
    button: 'down',
  },
  {
    peerId: 'cursor-only',
    userName: 'Not admitted',
    color: '#ff0000',
    x: 90,
    y: 100,
    button: 'up',
  },
];

describe('collaboratorsFromPresence', () => {
  it('maps admitted users and their cursors into native collaborators', () => {
    const collaborators = collaboratorsFromPresence(users, cursors, 'local');

    expect([...collaborators.keys()]).toEqual(['host', 'student']);
    expect(collaborators.get('host' as SocketId)).toMatchObject({
      username: 'Name (Host)',
      pointer: { x: 12, y: 34, tool: 'pointer' },
      button: 'down',
      color: { background: '#abcdef', stroke: '#abcdef' },
    });
    expect(collaborators.get('student' as SocketId)).toMatchObject({
      username: 'Student',
      color: { background: '#445566', stroke: '#445566' },
    });
    expect(collaborators.has('cursor-only' as SocketId)).toBe(false);
  });
});

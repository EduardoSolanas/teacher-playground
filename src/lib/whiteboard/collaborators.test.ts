import { describe, expect, it } from 'vitest';
import type { SocketId } from '@teacher-playground/excalidraw/types';
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
  {
    peerId: 'quiet',
    userName: 'Quiet',
    color: '#778899',
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
    peerId: 'quiet',
    userName: 'Quiet',
    color: '#0a0b0c',
    x: 1,
    y: 2,
    button: 'up',
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

    expect([...collaborators.keys()]).toEqual(['host', 'student', 'quiet']);
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
    expect(collaborators.get('quiet' as SocketId)).toMatchObject({
      username: 'Quiet',
      pointer: { x: 1, y: 2, tool: 'pointer' },
      button: 'up',
      color: { background: '#0a0b0c', stroke: '#0a0b0c' },
    });
    expect(collaborators.has('cursor-only' as SocketId)).toBe(false);
  });

  it('hands the editor a laser as a laser, so it draws the trail', () => {
    const pointing: RemoteCursor[] = [
      { peerId: 'host', userName: 'Name', color: '#abcdef', x: 5, y: 6, button: 'down', tool: 'laser' },
      { peerId: 'student', userName: 'Student', color: '#445566', x: 7, y: 8, button: 'down', tool: 'pointer' },
    ];

    const collaborators = collaboratorsFromPresence(users, pointing, 'local');

    expect(collaborators.get('host' as SocketId)?.pointer).toEqual({ x: 5, y: 6, tool: 'laser' });
    expect(collaborators.get('student' as SocketId)?.pointer).toEqual({ x: 7, y: 8, tool: 'pointer' });
  });
});

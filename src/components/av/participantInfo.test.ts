import { describe, expect, it } from 'vitest';

import { resolveParticipantInfo, type AvUser } from './AvSessionPanel';

describe('resolveParticipantInfo', () => {
  it('carries the board user colour and host flag to the participant tile', () => {
    const users: AvUser[] = [
      {
        peerId: 'peer-teacher',
        userName: 'Teacher',
        color: '#e74c3c',
        isHost: true,
      },
    ];

    expect(resolveParticipantInfo('peer-teacher', 'peer-student', false, users)).toMatchObject({
      color: '#e74c3c',
      isHost: true,
    });
  });

  it('resolves board metadata for the local participant sentinel', () => {
    const users: AvUser[] = [
      {
        peerId: 'peer-teacher',
        userName: 'Teacher',
        color: '#e74c3c',
        isHost: true,
      },
    ];

    expect(resolveParticipantInfo('__local__', 'peer-teacher', true, users)).toMatchObject({
      color: '#e74c3c',
      isHost: true,
    });
  });
});

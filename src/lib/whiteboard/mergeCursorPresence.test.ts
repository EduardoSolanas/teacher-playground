import { describe, expect, it } from 'vitest';
import { mergeCursorPresence } from './mergeCursorPresence';

describe('mergeCursorPresence', () => {
  it('does not add a roster row for a cursor id the presence API has not admitted', () => {
    const users = mergeCursorPresence(
      [{ peerId: 'user-server', userName: 'Host', color: '#111111', isHost: true }],
      [{ peerId: 'user-minted', userName: 'Ghost', color: '#222222', x: 1, y: 2, button: 'up' }],
    );
    expect(users.map((user) => user.peerId)).toEqual(['user-server']);
  });

  it('copies name and color onto a matching admitted peer', () => {
    const users = mergeCursorPresence(
      [{ peerId: 'user-server', userName: 'Old', color: '#111111', isHost: false }],
      [{ peerId: 'user-server', userName: 'CursorPeer', color: '#abcdef', x: 4, y: 5, button: 'up' }],
    );
    expect(users).toEqual([
      { peerId: 'user-server', userName: 'CursorPeer', color: '#abcdef', isHost: false },
    ]);
  });
});

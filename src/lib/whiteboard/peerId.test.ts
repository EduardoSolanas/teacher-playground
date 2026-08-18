import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStablePeerId, peerIdStorageKey, peerIdWhenJoined } from './peerId';

describe('getStablePeerId (SEC-006)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('minted peer ids use CSPRNG and ignore Math.random', () => {
    const math = vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = getStablePeerId('room-a');
    const second = getStablePeerId('room-b');

    expect(math).not.toHaveBeenCalled();
    expect(first).toMatch(/^user-[0-9a-f]{32}$/);
    expect(second).toMatch(/^user-[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    expect(localStorage.getItem(peerIdStorageKey('room-a'))).toBe(first);
  });

  it('returns the stored label on later visits', () => {
    localStorage.setItem(peerIdStorageKey('room-a'), 'user-already-saved');
    expect(getStablePeerId('room-a')).toBe('user-already-saved');
  });

  it('does not mint a peer id after leave when not joined', () => {
    expect(peerIdWhenJoined(false, 'left-room')).toBeNull();
    expect(localStorage.getItem(peerIdStorageKey('left-room'))).toBeNull();
  });

  it('mints a peer id only once the account has joined', () => {
    const id = peerIdWhenJoined(true, 'joined-room');
    expect(id).toMatch(/^user-[0-9a-f]{32}$/);
    expect(localStorage.getItem(peerIdStorageKey('joined-room'))).toBe(id);
  });
});

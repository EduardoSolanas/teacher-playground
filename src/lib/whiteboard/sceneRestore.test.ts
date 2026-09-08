import { describe, expect, it } from 'vitest';

import { shouldRestoreScene } from './sceneRestore';

describe('shouldRestoreScene', () => {
  it('restores a board the editor does not have', () => {
    const shared = [{ id: 'a', type: 'image', fileId: 'f1', version: 3 }];

    expect(shouldRestoreScene(shared, [])).toBe(true);
  });

  it('leaves an editor that already holds the board alone', () => {
    const shared = [{ id: 'a', type: 'image', fileId: 'f1', version: 3 }];

    expect(shouldRestoreScene(shared, shared)).toBe(false);
  });

  it('has nothing to restore from an empty document', () => {
    expect(shouldRestoreScene([], [])).toBe(false);
  });

  /*
   * The reload failure this exists for.
   *
   * The document syncs before the editor has mounted, so the scene is only
   * queued -- and Excalidraw overwrites a queued scene while it finishes
   * initialising. Deciding by what arrived on the wire rather than by what the
   * editor is holding read that board as already restored and left the canvas
   * empty for the rest of the session.
   */
  it('restores a board that synced before the editor existed', () => {
    const shared = [{ id: 'a', type: 'image', fileId: 'f1', version: 3 }];
    const held: unknown[] = [];

    expect(shouldRestoreScene(shared, held)).toBe(true);
  });

  it('restores when the editor holds an older version of the board', () => {
    const shared = [{ id: 'a', type: 'rectangle', version: 9 }];
    const held = [{ id: 'a', type: 'rectangle', version: 3 }];

    expect(shouldRestoreScene(shared, held)).toBe(true);
  });
});

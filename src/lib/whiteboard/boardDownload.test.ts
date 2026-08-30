import { describe, expect, it } from 'vitest';

import { collectBoardFiles, elementsFromSceneResponse } from './boardDownload';

/** A real Response carrying real bytes; no library is stood in for here. */
function imageResponse(bytes: number[], mimeType = 'image/webp'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': mimeType },
  });
}

describe('collectBoardFiles', () => {
  it('carries each picture back as a data URL', async () => {
    const files = await collectBoardFiles(
      'room-1',
      ['photo-1'],
      async () => imageResponse([1, 2, 3]),
      42,
    );
    expect(files).toEqual([{
      id: 'photo-1',
      dataURL: `data:image/webp;base64,${btoa('\x01\x02\x03')}`,
      mimeType: 'image/webp',
      created: 42,
    }]);
  });

  it('asks for each picture under the room it belongs to', async () => {
    const asked: string[] = [];
    await collectBoardFiles('room-9', ['a', 'b'], async (url) => {
      asked.push(url);
      return imageResponse([7]);
    });
    expect(asked).toEqual([
      '/api/whiteboard/room/room-9/files/a',
      '/api/whiteboard/room/room-9/files/b',
    ]);
  });

  /*
   * A picture that will not come must not cost the board. One image lost to a
   * bucket error taking the whole export with it is the opposite of what a
   * backup is for, and the file still opens: the missing picture shows as
   * Excalidraw's own placeholder rather than as a broken document.
   */
  it('leaves out what it cannot fetch and keeps the rest', async () => {
    const files = await collectBoardFiles('room-1', ['bad', 'good'], async (url) => {
      if (url.endsWith('bad')) return new Response('nope', { status: 404 });
      return imageResponse([9]);
    });
    expect(files.map((file) => file.id)).toEqual(['good']);
  });

  it('survives a fetch that throws outright', async () => {
    const files = await collectBoardFiles('room-1', ['a', 'b'], async (url) => {
      if (url.endsWith('a')) throw new Error('offline');
      return imageResponse([1]);
    });
    expect(files.map((file) => file.id)).toEqual(['b']);
  });

  it('refuses a type the room would not have accepted', async () => {
    // SVG is kept out of board files deliberately -- it can carry script --
    // so an export must not be the way one arrives back on a board.
    const files = await collectBoardFiles('room-1', ['svg'], async () => (
      imageResponse([1, 2], 'image/svg+xml')
    ));
    expect(files).toEqual([]);
  });

  it('skips an empty body rather than writing an empty picture', async () => {
    const files = await collectBoardFiles('room-1', ['empty'], async () => imageResponse([]));
    expect(files).toEqual([]);
  });
});

describe('elementsFromSceneResponse', () => {
  it('reads the elements out of a room response', () => {
    expect(elementsFromSceneResponse({ elements: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
  });

  it('answers empty for anything unexpected', () => {
    // This runs inside a click handler, where a throw is invisible.
    expect(elementsFromSceneResponse(null)).toEqual([]);
    expect(elementsFromSceneResponse({})).toEqual([]);
    expect(elementsFromSceneResponse({ elements: 'no' })).toEqual([]);
    expect(elementsFromSceneResponse('nonsense')).toEqual([]);
  });
});

import { useState } from 'react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

import BoardTabs from './BoardTabs';
import type { AjaxFetch } from '@/lib/whiteboard/teacherRooms';

type TabsProps = ComponentProps<typeof BoardTabs>;

/*
 * The room shell the tabs live in: active-board state held exactly where
 * RoomClient holds it, and every prop the real thing -- a real Y.Doc, real
 * Response objects over the injected request seam, no test doubles.
 */
function TabsRoom(props: Omit<TabsProps, 'activeBoardId' | 'onSelectBoard'>) {
  const [activeBoardId, setActiveBoardId] = useState('main');
  return (
    <BoardTabs
      {...props}
      activeBoardId={activeBoardId}
      onSelectBoard={setActiveBoardId}
    />
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Main is never stored; the count is seeded boards beside it. */
function seededDoc(boards: number): Y.Doc {
  const doc = new Y.Doc();
  for (let i = 1; i < boards; i += 1) {
    doc.getMap('boardsMeta').set(`board-${i}`, { name: `Board ${i + 1}`, order: i });
  }
  return doc;
}

function tabIds(): string[] {
  return screen
    .getAllByTestId(/^board-tab-/)
    .map((tab) => tab.getAttribute('data-testid') ?? '');
}

describe('BoardTabs', () => {
  it('renders one tab per board with the main board first', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    expect(tabIds()).toEqual(['board-tab-main', 'board-tab-board-1', 'board-tab-board-2']);
    expect(screen.getByTestId('board-tab-main').textContent).toBe('Board 1');
  });

  it('marks the active tab and switches the active board when a tab is clicked', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('board-tab-board-1'));

    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('false');
  });

  it('the add control activates the newly added board', async () => {
    const doc = seededDoc(2);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.click(screen.getByTestId('board-tabs-add'));

    await waitFor(() => {
      expect(tabIds()).toHaveLength(3);
    });
    const tabs = screen.getAllByTestId(/^board-tab-/);
    expect(tabs[tabs.length - 1].getAttribute('aria-pressed')).toBe('true');
    expect(tabs[0].getAttribute('aria-pressed')).toBe('false');
    // The write travelled through the shared document, not around it.
    expect(doc.getMap('boardsMeta').size).toBe(2);
  });

  it('the add control refuses to switch when the hook falls back to the main board', () => {
    // Main + 49 seeded boards: the room is at its cap, addBoard keeps 'main'.
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(50)} canClearBoard />);
    expect(tabIds()).toHaveLength(50);

    fireEvent.click(screen.getByTestId('board-tabs-add'));

    expect(tabIds()).toHaveLength(50);
    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('board-tabs-add-refused')).toBeTruthy();
  });

  it('the clear control posts the active board id to the clear route', async () => {
    const posts: Array<{ url: string; method?: string; body: unknown }> = [];
    let release!: (response: Response) => void;
    const request: AjaxFetch = (input, init) => {
      if (String(input).endsWith('/clear')) {
        return new Promise<Response>((resolve) => {
          posts.push({
            url: String(input),
            method: init?.method,
            body: JSON.parse(String(init?.body)),
          });
          release = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    };
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    const clear = screen.getByTestId('board-tabs-clear');
    fireEvent.click(clear);
    expect(clear).toHaveProperty('disabled', true);

    release(jsonResponse({ ok: true }));

    await waitFor(() => {
      expect(screen.getByTestId('board-tabs-clear-done')).toBeTruthy();
    });
    expect(screen.getByTestId('board-tabs-clear')).toHaveProperty('disabled', false);
    expect(posts).toEqual([
      {
        url: '/api/whiteboard/room/room-alpha/clear',
        method: 'POST',
        body: { boardId: 'board-1' },
      },
    ]);
  });

  it('surfaces a refused clear as an outcome message and keeps the board', async () => {
    const request: AjaxFetch = async (input) => {
      if (String(input).endsWith('/clear')) return jsonResponse({ error: 'no' }, 403);
      return jsonResponse({});
    };
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-clear'));

    expect(await screen.findByTestId('board-tabs-clear-error')).toBeTruthy();
    // The board is still the active one: a refusal changes nothing.
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('surfaces a failed clear request as an outcome message', async () => {
    const request: AjaxFetch = async (input) => {
      if (String(input).endsWith('/clear')) throw new Error('socket gone');
      return jsonResponse({});
    };
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tabs-clear'));

    expect(await screen.findByTestId('board-tabs-clear-error')).toBeTruthy();
  });

  it('hides the clear control from a non-owner', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard={false} />);

    expect(screen.getByTestId('board-tabs-add')).toBeTruthy();
    expect(screen.queryByTestId('board-tabs-clear')).toBeNull();
  });
});

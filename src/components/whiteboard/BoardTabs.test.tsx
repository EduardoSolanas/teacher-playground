import { useState } from 'react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    fireEvent.click(screen.getByTestId('board-tabs-clear'));
    // Nothing has been asked of the room yet: the dialog stands between.
    expect(posts).toEqual([]);

    fireEvent.click(screen.getByTestId('board-clear-confirm-btn'));
    const clear = screen.getByTestId('board-tabs-clear');
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

  it('clearing asks for confirmation and cancelling changes nothing', async () => {
    const posts: Array<{ url: string }> = [];
    const request: AjaxFetch = (input) => {
      posts.push({ url: String(input) });
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-clear'));
    fireEvent.click(screen.getByTestId('board-clear-cancel-btn'));

    expect(screen.queryByTestId('board-clear-confirm-btn')).toBeNull();
    // Only the room read the strip mounted with; no clear was ever asked.
    expect(posts.filter((post) => post.url.endsWith('/clear'))).toEqual([]);
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('the clear and delete dialogs name the active board', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-clear'));
    expect(screen.getByText(/'Board 2'/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('board-clear-cancel-btn'));

    fireEvent.click(screen.getByTestId('board-tabs-delete'));
    expect(screen.getByText(/'Board 2'/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('board-delete-cancel-btn'));
  });

  it('surfaces a refused clear as an outcome message and keeps the board', async () => {
    const request: AjaxFetch = async (input) => {
      if (String(input).endsWith('/clear')) return jsonResponse({ error: 'no' }, 403);
      return jsonResponse({});
    };
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-clear'));
    fireEvent.click(screen.getByTestId('board-clear-confirm-btn'));

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
    fireEvent.click(screen.getByTestId('board-clear-confirm-btn'));

    expect(await screen.findByTestId('board-tabs-clear-error')).toBeTruthy();
  });

  it('hides the clear control from a non-owner', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard={false} />);

    expect(screen.getByTestId('board-tabs-add')).toBeTruthy();
    expect(screen.queryByTestId('board-tabs-clear')).toBeNull();
  });

  it('renames a board through the inline editor', () => {
    const doc = seededDoc(3);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.doubleClick(screen.getByTestId('board-tab-board-2'));

    const input = screen.getByTestId('board-name-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Board 3');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    fireEvent.change(input, { target: { value: 'Algebra' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByTestId('board-name-input')).toBeNull();
    expect(screen.getByTestId('board-tab-board-2').textContent).toBe('Algebra');
    // The write went through the shared document, the definition's other
    // fields (here the order) intact beside the new name.
    expect(doc.getMap('boardsMeta').get('board-2')).toEqual({ name: 'Algebra', order: 2 });
  });

  it('escape cancels the rename without writing', () => {
    const doc = seededDoc(3);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.doubleClick(screen.getByTestId('board-tab-board-1'));
    const input = screen.getByTestId('board-name-input');
    fireEvent.change(input, { target: { value: 'Algebra' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('board-name-input')).toBeNull();
    expect(screen.getByTestId('board-tab-board-1').textContent).toBe('Board 2');
    expect(doc.getMap('boardsMeta').get('board-1')).toEqual({ name: 'Board 2', order: 1 });

    // Opening it again drafts from the board's live name, not the cancelled one.
    fireEvent.doubleClick(screen.getByTestId('board-tab-board-1'));
    expect((screen.getByTestId('board-name-input') as HTMLInputElement).value).toBe('Board 2');
  });

  it('the main board offers no rename', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    fireEvent.doubleClick(screen.getByTestId('board-tab-main'));

    expect(screen.queryByTestId('board-name-input')).toBeNull();
    expect(screen.getByTestId('board-tab-main').textContent).toBe('Board 1');
  });

  it('the pencil beside each tab opens the inline editor', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    fireEvent.click(screen.getByTestId('board-pencil-board-1'));

    const input = screen.getByTestId('board-name-input') as HTMLInputElement;
    expect(input.value).toBe('Board 2');
  });

  it('the main board offers no pencil', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    expect(screen.queryByTestId('board-pencil-main')).toBeNull();
    expect(screen.getByTestId('board-pencil-board-1')).toBeTruthy();
  });

  it('a blank rename leaves the name unchanged', () => {
    const doc = seededDoc(3);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.doubleClick(screen.getByTestId('board-tab-board-1'));
    const input = screen.getByTestId('board-name-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The hook refuses a blank silently: the editor closes with nothing
    // written and no success state.
    expect(screen.queryByTestId('board-name-input')).toBeNull();
    expect(screen.getByTestId('board-tab-board-1').textContent).toBe('Board 2');
    expect(doc.getMap('boardsMeta').get('board-1')).toEqual({ name: 'Board 2', order: 1 });
  });

  it('blurring the editor commits the rename', () => {
    const doc = seededDoc(3);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.doubleClick(screen.getByTestId('board-tab-board-1'));
    const input = screen.getByTestId('board-name-input');
    fireEvent.change(input, { target: { value: 'Algebra' } });
    fireEvent.blur(input);

    expect(screen.queryByTestId('board-name-input')).toBeNull();
    expect(screen.getByTestId('board-tab-board-1').textContent).toBe('Algebra');
  });

  it('the owner deletes the active board through the confirm dialog', async () => {
    const doc = seededDoc(2);
    const posts: Array<{ url: string; method?: string; body: unknown }> = [];
    const request: AjaxFetch = (input, init) => {
      posts.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
      // The real route's effect, applied where the real server would apply
      // it: the boardsMeta write the peers receive as the broadcast frame.
      const url = String(input);
      if (url.endsWith('/boards/delete')) {
        doc.getMap('boardsMeta').delete((JSON.parse(String(init?.body)) as { boardId: string }).boardId);
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-delete'));
    fireEvent.click(screen.getByTestId('board-delete-confirm-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('board-tabs-delete-done')).toBeTruthy();
    });
    expect(posts).toEqual([
      {
        url: '/api/whiteboard/room/room-alpha/boards/delete',
        method: 'POST',
        body: { boardId: 'board-1' },
      },
    ]);
    // The tab was the document's own: with the meta entry gone it is gone,
    // and the room sits back on the main board.
    expect(tabIds()).toEqual(['board-tab-main']);
    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
  });

  it('cancelling the dialog keeps the board', () => {
    const request: AjaxFetch = () => Promise.resolve(jsonResponse({ ok: true }));
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-delete'));
    fireEvent.click(screen.getByTestId('board-delete-cancel-btn'));

    expect(screen.getByTestId('board-tab-board-1')).toBeTruthy();
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('a failed delete reports and keeps the board', async () => {
    const request: AjaxFetch = () => Promise.resolve(jsonResponse({ error: 'no' }, 403));
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    fireEvent.click(screen.getByTestId('board-tabs-delete'));
    fireEvent.click(screen.getByTestId('board-delete-confirm-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('board-tabs-delete-error')).toBeTruthy();
    });
    expect(screen.getByTestId('board-tab-board-1')).toBeTruthy();
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');
  });

  it('the delete control is hidden on the main board and from a non-owner', () => {
    const doc = seededDoc(2);
    const { rerender } = render(
      <TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />,
    );
    expect(screen.queryByTestId('board-tabs-delete')).toBeNull();

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    expect(screen.getByTestId('board-tabs-delete')).toBeTruthy();

    rerender(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard={false} />);
    expect(screen.queryByTestId('board-tabs-delete')).toBeNull();
  });

  it('a room whose active board is deleted by the owner lands back on main', () => {
    // The member's path: the deletion arrives as a document update, not a
    // click, so nothing in the delete flow switches this client -- the strip
    // itself has to notice the active board is gone.
    const doc = seededDoc(2);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard={false} />);

    fireEvent.click(screen.getByTestId('board-tab-board-1'));
    expect(screen.getByTestId('board-tab-board-1').getAttribute('aria-pressed')).toBe('true');

    act(() => {
      doc.getMap('boardsMeta').delete('board-1');
    });

    expect(screen.getByTestId('board-tab-main').getAttribute('aria-pressed')).toBe('true');
  });

  it('F2 opens the rename editor, except on the main board', () => {
    const doc = seededDoc(2);
    render(<TabsRoom roomId="room-alpha" yDoc={doc} canClearBoard />);

    fireEvent.keyDown(screen.getByTestId('board-tab-board-1'), { key: 'F2' });
    expect(screen.getByTestId('board-name-input')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('board-name-input'), { key: 'Escape' });

    fireEvent.keyDown(screen.getByTestId('board-tab-main'), { key: 'F2' });
    expect(screen.queryByTestId('board-name-input')).toBeNull();
  });

  it('the tab tooltip offers the rename shortcut and marks the main board', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard />);

    expect(screen.getByTestId('board-tab-board-1').getAttribute('title')).toMatch(/F2/);
    expect(screen.getByTestId('board-tab-main').getAttribute('title')).toMatch(/first board/);
  });

  it('a success outcome dismisses itself while an error stays', async () => {
    vi.useFakeTimers();
    try {
      let ok = true;
      const request: AjaxFetch = async (input) => {
        if (String(input).endsWith('/clear')) {
          return ok ? jsonResponse({ ok: true }) : jsonResponse({ error: 'no' }, 403);
        }
        return jsonResponse({});
      };
      render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(2)} canClearBoard request={request} />);

      fireEvent.click(screen.getByTestId('board-tab-board-1'));
      fireEvent.click(screen.getByTestId('board-tabs-clear'));
      fireEvent.click(screen.getByTestId('board-clear-confirm-btn'));
      await act(async () => {});
      expect(screen.getByTestId('board-tabs-clear-done')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(4500);
      });
      expect(screen.queryByTestId('board-tabs-clear-done')).toBeNull();

      ok = false;
      fireEvent.click(screen.getByTestId('board-tabs-clear'));
      fireEvent.click(screen.getByTestId('board-clear-confirm-btn'));
      await act(async () => {});
      expect(screen.getByTestId('board-tabs-clear-error')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(screen.getByTestId('board-tabs-clear-error')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the add refusal separates a capped room from an offline one', () => {
    const capped = render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(50)} canClearBoard />);
    fireEvent.click(screen.getByTestId('board-tabs-add'));
    expect(screen.getByTestId('board-tabs-add-refused').textContent).toMatch(/\(50\)/);
    capped.unmount();

    render(<TabsRoom roomId="room-beta" yDoc={null} canClearBoard />);
    fireEvent.click(screen.getByTestId('board-tabs-add'));
    expect(screen.getByTestId('board-tabs-add-offline')).toBeTruthy();
  });

  it('the tab run scrolls while the controls stay pinned outside it', () => {
    render(<TabsRoom roomId="room-alpha" yDoc={seededDoc(3)} canClearBoard />);

    // The delete control exists only for a non-main active board.
    fireEvent.click(screen.getByTestId('board-tab-board-1'));

    const run = screen.getByTestId('board-tabs-run');
    expect(run.contains(screen.getByTestId('board-tab-main'))).toBe(true);
    expect(run.contains(screen.getByTestId('board-tab-board-2'))).toBe(true);
    // The controls a teacher mid-lesson cannot lose sit outside the scroll.
    expect(run.contains(screen.getByTestId('board-tabs-add'))).toBe(false);
    expect(run.contains(screen.getByTestId('board-tabs-clear'))).toBe(false);
    expect(run.contains(screen.getByTestId('board-tabs-delete'))).toBe(false);
  });
});

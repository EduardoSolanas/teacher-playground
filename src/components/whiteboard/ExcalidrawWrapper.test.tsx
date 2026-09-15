import type { ComponentProps } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { getElementsFromArray, replaceSharedElements } from '@/lib/whiteboard/yjsDoc';
import {
  clearWhiteboardLatencyEvents,
  readWhiteboardLatencyEvents,
} from '@/lib/whiteboard/latencyProbe';

import {
  loadExcalidrawPackage,
  loadExcalidrawWrapper,
  setFetchHandler,
} from './excalidrawTestEnvironment';

type WrapperComponent = Awaited<ReturnType<typeof loadExcalidrawWrapper>>;
type WrapperProps = ComponentProps<WrapperComponent>;

function createYjsBoard(): { doc: Y.Doc; array: Y.Array<Y.Map<unknown>> } {
  const doc = new Y.Doc();
  return { doc, array: doc.getArray<Y.Map<unknown>>('elements') };
}

function createProps(): WrapperProps {
  const { doc, array } = createYjsBoard();
  return {
    roomId: 'room-1',
    activeBoardId: 'main',
    userName: 'Alice',
    localPeerId: 'peer-1',
    yDoc: doc,
    yElementsArray: array,
    users: [],
    cursors: [],
    activeTool: 'select',
    isLocalHost: true,
    onToolChange: () => {},
    onViewportChange: () => {},
    initialViewport: null,
    onCursorMove: () => {},
    onElementsChange: () => {},
    hostPeerId: null,
    guideMessage: null,
    isGuiding: false,
    onGuideViewport: () => {},
  };
}

async function renderWrapper(overrides: Partial<WrapperProps> = {}) {
  const ExcalidrawWrapper = await loadExcalidrawWrapper();
  const props = { ...createProps(), ...overrides } satisfies WrapperProps;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ExcalidrawWrapper {...props} />);
  });
  await waitFor(() => {
    expect(window.__debugExcalidrawApi).toBeTruthy();
  });
  return { view, props, api: window.__debugExcalidrawApi!, ExcalidrawWrapper };
}

function remoteBoard(): { doc: Y.Doc; array: Y.Array<Y.Map<unknown>> } {
  const doc = new Y.Doc();
  return { doc, array: doc.getArray<Y.Map<unknown>>('elements') };
}

function seedRemote(
  doc: Y.Doc,
  array: Y.Array<Y.Map<unknown>>,
  elements: readonly Record<string, unknown>[],
): void {
  replaceSharedElements(doc, array, elements, 'seed');
}

function syncFromRemote(target: Y.Doc, remote: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(remote), 'remote-sync');
}

async function settleApiReady(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
}

function pointerEvent(type: string, init: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: 100,
    clientY: 100,
    ...init,
  });
  return event;
}

function interactiveCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.interactive');
  expect(canvas).toBeTruthy();
  return canvas!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function rectangleElements(ids: string[]) {
  const { convertToExcalidrawElements } = await loadExcalidrawPackage();
  return convertToExcalidrawElements(
    ids.map((id, index) => ({
      type: 'rectangle' as const,
      id,
      x: 10 + index * 40,
      y: 20,
      width: 100,
      height: 50,
    })),
    { regenerateIds: false },
  );
}

describe('ExcalidrawWrapper rendering', () => {
  it('renders the real editor for the host', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));

    const { view } = await renderWrapper();

    expect(view.container.querySelector('[data-whiteboard-role="host"]')).toBeTruthy();
    expect(view.container.querySelector('.excalidraw')).toBeTruthy();
  });

  it('marks a non-host board as a peer board', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));

    const { view } = await renderWrapper({ isLocalHost: false });

    expect(view.container.querySelector('[data-whiteboard-role="peer"]')).toBeTruthy();
  });

  it('places the room footer inside the editor footer', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));

    const { view } = await renderWrapper({
      footer: <button type="button">Room controls</button>,
    });

    expect(view.container.querySelector('footer')).toBeTruthy();
    expect(view.container.textContent).toContain('Room controls');
  });

  it('exposes board actions and reports the library sidebar opening', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onBoardActions = vi.fn();
    const onSidebarOpenChange = vi.fn();

    await renderWrapper({ onBoardActions, onSidebarOpenChange });

    const actions = onBoardActions.mock.calls.at(-1)?.[0];
    expect(actions).toBeTruthy();
    expect(actions.readScene().elements).toEqual(expect.any(Array));

    await act(async () => {
      actions.openLibrary();
    });

    await waitFor(() => {
      expect(onSidebarOpenChange).toHaveBeenCalledWith(true);
    });
  });
});

describe('ExcalidrawWrapper scene sync', () => {
  it('restores a shared scene onto an empty editor and reports it', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const [rectangle] = await rectangleElements(['rect-restored']);
    replaceSharedElements(doc, array, [rectangle], 'local');
    const onElementsChange = vi.fn();

    const { api } = await renderWrapper({
      yDoc: doc,
      yElementsArray: array,
      onElementsChange,
    });

    await waitFor(() => {
      expect(api.getSceneElements().some((element) => element.id === 'rect-restored')).toBe(true);
    });
    await waitFor(() => {
      expect(onElementsChange).toHaveBeenCalled();
    });
    expect(onElementsChange.mock.calls.at(-1)?.[0].some(
      (element: { id: string }) => element.id === 'rect-restored',
    )).toBe(true);
  });

  it('publishes a local scene change into the shared document', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['rect-local']);

    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });

    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
    });

    await waitFor(() => {
      expect(array.toArray().some((map) => map.get('id') === 'rect-local')).toBe(true);
    });
  });

  it('removes an element from the shared document when the scene drops it', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['rect-a', 'rect-b']);

    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(array.toArray()).toHaveLength(2);
    });

    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(array.toArray().map((map) => map.get('id'))).toEqual(['rect-a']);
    });
  });

  it('keeps the shared board when Excalidraw reports an empty scene', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['rect-stays']);

    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(array.toArray()).toHaveLength(1);
    });

    await act(async () => {
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER });
    });
    expect(array.toArray().map((map) => map.get('id'))).toEqual(['rect-stays']);
  });

  it('flushes elements drawn before the shared document arrives once the room has synced', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    // Concurrent inserts of one id integrate in client-id order; fixed ids
    // keep the expected document order deterministic in both directions.
    doc.clientID = 1;
    remote.doc.clientID = 2;
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['rect-pending']);
    const [roomElement] = await rectangleElements(['rect-room']);

    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      yDoc: null,
      yElementsArray: null,
    });
    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
    });

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} yDoc={doc} yElementsArray={array} />);
    });
    /*
     * The publish waits for the room's first sync: publishing into a document
     * the server is still filling races the server's own copy of the same
     * elements. The sync below opens the gate, and the flush lands merged
     * behind it.
     */
    await act(async () => {
      seedRemote(remote.doc, remote.array, [roomElement]);
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(array.toArray().map((map) => map.get('id')).filter(
        (id) => typeof id === 'string',
      )).toEqual(['rect-room', 'rect-pending']);
    });
  });

  it('publishes the pre-socket scene after the first sync, merged with what arrived', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    /*
     * Concurrent inserts of one id integrate in client-id order, the lower id
     * first. Fixing them pins which struct a collapsed duplicate would keep,
     * so the race below fails for its assertion rather than by luck.
     */
    doc.clientID = 1;
    remote.doc.clientID = 2;
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [local] = await rectangleElements(['rect-late']);
    const [stored] = await rectangleElements(['rect-late']);
    // The room's stored snapshot is staler than what its live document holds.
    const serverNewer = { ...stored, x: stored.x + 40, version: (stored.version ?? 1) + 4 };

    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      yDoc: null,
      yElementsArray: null,
    });
    await act(async () => {
      api.updateScene({ elements: [local], captureUpdate: CaptureUpdateAction.NEVER });
    });

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} yDoc={doc} yElementsArray={array} />);
    });
    // The server's own copy of the element lands around the first publish.
    await act(async () => {
      seedRemote(remote.doc, remote.array, [serverNewer]);
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(array.toArray().filter((map) => map.get('id') === 'rect-late')).toHaveLength(1);
    });
    const [element] = getElementsFromArray(array).filter((el) => el.id === 'rect-late');
    // What survives is the room's copy, not this client's racing one.
    expect((element as { x?: number }).x).toBe(serverNewer.x);
  });

  it('flushes the pre-socket scene when the room stays quiet past the escape', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['rect-quiet']);

    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      yDoc: null,
      yElementsArray: null,
    });
    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
    });

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} yDoc={doc} yElementsArray={array} />);
    });
    // Gated: a quiet room delivers nothing, so nothing is published yet.
    expect(array.toArray()).toHaveLength(0);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(array.toArray().map((map) => map.get('id'))).toEqual(['rect-quiet']);
  });
});

describe('ExcalidrawWrapper remote collaboration', () => {
  it('applies a peer scene and records render latency after the first frame', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    const [first, second] = await rectangleElements(['rect-remote', 'rect-remote-2']);
    clearWhiteboardLatencyEvents();

    seedRemote(remote.doc, remote.array, [first]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(api.getSceneElements().some((element) => element.id === 'rect-remote')).toBe(true);
    });

    seedRemote(remote.doc, remote.array, [first, second]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(api.getSceneElements().some((element) => element.id === 'rect-remote-2')).toBe(true);
    });
    await waitFor(() => {
      expect(
        readWhiteboardLatencyEvents().some(
          (event) => event.kind === 'stroke-render' && event.elementId === 'rect-remote-2',
        ),
      ).toBe(true);
    });
  });

  it('ignores a remote transaction that leaves the scene unchanged', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const onElementsChange = vi.fn();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array, onElementsChange });
    const [rectangle] = await rectangleElements(['rect-same']);

    seedRemote(remote.doc, remote.array, [rectangle]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(api.getSceneElements().some((element) => element.id === 'rect-same')).toBe(true);
    });
    const rendersSoFar = onElementsChange.mock.calls.length;

    await act(async () => {
      const map = remote.array.toArray()[0];
      map.set('x', map.get('x'));
      syncFromRemote(doc, remote.doc);
    });

    expect(onElementsChange.mock.calls.length).toBe(rendersSoFar);
  });

  it('tolerates remote element metadata it cannot use', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    const [rectangle] = await rectangleElements(['rect-valid']);

    const withoutId = new Y.Map<unknown>();
    withoutId.set('type', 'rectangle');
    const numericId = new Y.Map<unknown>();
    numericId.set('id', 123);
    numericId.set('type', 'rectangle');
    const stringVersion = new Y.Map<unknown>();
    stringVersion.set('id', 'rect-bad-version');
    stringVersion.set('type', 'rectangle');
    stringVersion.set('version', 'seven');

    await act(async () => {
      seedRemote(remote.doc, remote.array, [rectangle]);
      remote.array.push([withoutId, numericId, stringVersion]);
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(api.getSceneElements().some((element) => element.id === 'rect-valid')).toBe(true);
    });
  });

  it('collapses duplicate ids the document received from concurrent inserts', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const firstPeer = remoteBoard();
    const secondPeer = remoteBoard();
    await renderWrapper({ yDoc: doc, yElementsArray: array });
    const [first] = await rectangleElements(['rect-twin']);
    const [second] = await rectangleElements(['rect-twin']);

    seedRemote(firstPeer.doc, firstPeer.array, [first]);
    seedRemote(secondPeer.doc, secondPeer.array, [
      { ...second, version: (second.version ?? 1) + 3 },
    ]);
    await act(async () => {
      syncFromRemote(doc, firstPeer.doc);
      syncFromRemote(doc, secondPeer.doc);
    });

    await waitFor(() => {
      expect(array.toArray().filter((map) => map.get('id') === 'rect-twin')).toHaveLength(1);
    });
  });

  it('flushes a coalesced remote scene when the board unmounts', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const onElementsChange = vi.fn();
    const { view } = await renderWrapper({ yDoc: doc, yElementsArray: array, onElementsChange });
    const [rectangle] = await rectangleElements(['rect-flush']);

    seedRemote(remote.doc, remote.array, [rectangle]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });

    await act(async () => {
      view.unmount();
    });

    expect(
      onElementsChange.mock.calls.some(([elements]) =>
        (elements as { id: string }[]).some((element) => element.id === 'rect-flush'),
      ),
    ).toBe(true);
  });
});

describe('ExcalidrawWrapper tools and viewport', () => {
  it('pushes a mapped app tool into the editor without echoing it back', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onToolChange = vi.fn();
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      onToolChange,
      activeTool: 'select',
    });
    await settleApiReady();

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} activeTool="rectangle" />);
    });

    await waitFor(() => {
      expect(api.getAppState().activeTool.type).toBe('rectangle');
    });
    expect(onToolChange).not.toHaveBeenCalled();
  });

  it('does not push a tool the application cannot name', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onToolChange = vi.fn();
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      onToolChange,
      activeTool: 'select',
    });
    await settleApiReady();

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} activeTool="hand" />);
    });
    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} activeTool="" />);
    });

    expect(api.getAppState().activeTool.type).toBe('selection');
    expect(onToolChange).not.toHaveBeenCalled();
  });

  it('reports a tool chosen in the editor toolbar with the app tool name', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onToolChange = vi.fn();
    await renderWrapper({ onToolChange, activeTool: 'select' });
    await settleApiReady();

    const ellipse = document.querySelector<HTMLInputElement>('[data-testid="toolbar-ellipse"]');
    expect(ellipse).toBeTruthy();
    await act(async () => {
      fireEvent.click(ellipse!);
    });

    await waitFor(() => {
      expect(onToolChange).toHaveBeenCalledWith('circle');
    });
  });

  it('reports viewport changes the editor makes', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onViewportChange = vi.fn();
    const { api } = await renderWrapper({ onViewportChange });

    await act(async () => {
      api.updateScene({ appState: { scrollX: 25, scrollY: 50 } });
    });

    await waitFor(() => {
      expect(onViewportChange).toHaveBeenCalledWith({ x: 25, y: 50, zoom: 1 });
    });
  });

  it('applies the stored viewport once and never again', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper();
    await settleApiReady();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper {...props} initialViewport={{ x: 10, y: 20, zoom: 2 }} />,
      );
    });
    await waitFor(() => {
      expect(api.getAppState().scrollX).toBe(10);
    });

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper {...props} initialViewport={{ x: 99, y: 99, zoom: 4 }} />,
      );
    });
    expect(api.getAppState().scrollX).toBe(10);
  });

  it('skips a stored viewport that describes the default view', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper();
    await settleApiReady();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper {...props} initialViewport={{ x: 0, y: 0, zoom: 1 }} />,
      );
    });
    expect(api.getAppState().scrollX).toBe(0);

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper {...props} initialViewport={{ x: 40, y: 40, zoom: 2 }} />,
      );
    });

    await waitFor(() => {
      expect(api.getAppState().scrollX).toBe(40);
    });
  });
});

describe('ExcalidrawWrapper guiding and follow', () => {
  const teacher = { peerId: 'host-1', userName: 'Teacher', color: '#112233', isHost: true };

  it('sends the current viewport when guiding starts', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onGuideViewport = vi.fn();
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      onGuideViewport,
      users: [teacher],
    });
    await settleApiReady();

    await act(async () => {
      api.updateScene({ appState: { scrollX: 7, scrollY: 8 } });
    });
    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} isGuiding />);
    });

    await waitFor(() => {
      expect(onGuideViewport).toHaveBeenCalledWith({ x: 7, y: 8, zoom: 1 });
    });

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} isGuiding={false} />);
    });
    expect(api.getAppState().scrollX).toBe(7);
  });

  it('follows the host on an active guide message and releases on an inactive one', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      users: [teacher],
      hostPeerId: 'host-1',
    });
    await settleApiReady();

    await act(async () => {
      api.updateScene({
        appState: { userToFollow: { socketId: 'host-1' as never, username: 'Teacher' } },
      });
    });

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper
          {...props}
          guideMessage={{ active: true, viewport: { x: 12, y: 34, zoom: 1.5 } }}
        />,
      );
    });

    await waitFor(() => {
      expect(api.getAppState().userToFollow?.socketId).toBe('host-1');
      expect(api.getAppState().scrollX).toBe(12);
    });

    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} guideMessage={{ active: false }} />);
    });

    await waitFor(() => {
      expect(api.getAppState().userToFollow).toBeNull();
    });
  });

  it('does not follow when the guide is this peer', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      users: [{ ...teacher, peerId: 'peer-1' }],
      hostPeerId: 'peer-1',
      localPeerId: 'peer-1',
    });
    await settleApiReady();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper
          {...props}
          guideMessage={{ active: true, viewport: { x: 5, y: 6, zoom: 1 } }}
        />,
      );
    });

    expect(api.getAppState().userToFollow).toBeNull();
  });

  it('stays unfollowed after the user opts out inside the editor', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      users: [teacher],
      hostPeerId: 'host-1',
    });
    await settleApiReady();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper
          {...props}
          guideMessage={{ active: true, viewport: { x: 5, y: 6, zoom: 1 } }}
        />,
      );
    });
    await waitFor(() => {
      expect(api.getAppState().userToFollow?.socketId).toBe('host-1');
    });

    await act(async () => {
      api.updateScene({ appState: { userToFollow: null } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.getAppState().userToFollow).toBeNull();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper
          {...props}
          guideMessage={{ active: true, viewport: { x: 5, y: 6, zoom: 1 } }}
          users={[{ ...teacher }]}
        />,
      );
    });

    expect(api.getAppState().userToFollow).toBeNull();
  });
});

describe('ExcalidrawWrapper pointer handling', () => {
  it('reports cursor movement in scene coordinates with the button state', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onCursorMove = vi.fn();
    const { api } = await renderWrapper({ onCursorMove });
    const canvas = interactiveCanvas();

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 120, clientY: 80 }));
    });
    expect(onCursorMove).toHaveBeenCalledWith(120, 80, 'up');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', { buttons: 1 }));
    });
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 20, buttons: 1 }));
    });
    expect(onCursorMove).toHaveBeenLastCalledWith(10, 20, 'down');
  });

  it('throttles stroke publishes and flushes the stroke on pointer up', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['stroke-a', 'stroke-b']);
    const onElementsChange = vi.fn();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array, onElementsChange });
    const canvas = interactiveCanvas();

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', { buttons: 1, clientX: 100, clientY: 100 }));
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
    await act(async () => {
      api.updateScene({ elements: [second], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    });

    await waitFor(() => {
      expect(array.toArray().some((map) => map.get('id') === 'stroke-b')).toBe(true);
    });
    expect(onElementsChange).toHaveBeenCalled();
  });

  it('clears a pending trailing commit when the board unmounts', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['trailing-a', 'trailing-b']);
    const { api, view } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    const canvas = interactiveCanvas();

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', { buttons: 1 }));
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });

    expect(array.toArray().map((map) => map.get('id'))).toEqual(['trailing-a']);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function imageElements(entries: { id: string; fileId: string }[]) {
  const { convertToExcalidrawElements } = await loadExcalidrawPackage();
  return convertToExcalidrawElements(
    entries.map(({ id, fileId }) => ({
      type: 'image' as const,
      id,
      fileId: fileId as never,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      status: 'saved' as const,
      scale: [1, 1] as [number, number],
    })),
    { regenerateIds: false },
  );
}

describe('ExcalidrawWrapper board files', () => {
  it('uploads a pasted image once', async () => {
    const putCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') putCalls.push(url);
      return new Response(null, { status: 200 });
    });
    const { api } = await renderWrapper();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['img-a', 'img-b']);

    await act(async () => {
      api.addFiles([
        {
          id: 'file-up',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(putCalls).toHaveLength(1);
    });
    expect(putCalls[0]).toContain('/api/whiteboard/room/room-1/files/file-up');

    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(putCalls).toHaveLength(1);
  });

  it('does not upload malformed or disallowed image data', async () => {
    const putCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') putCalls.push(url);
      return new Response(null, { status: 200 });
    });
    const { api } = await renderWrapper();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['img-bad-el']);

    await act(async () => {
      api.addFiles([
        { id: 'file-bad', dataURL: 'not-a-data-url', mimeType: 'image/png', created: 1 },
        {
          id: 'file-text',
          dataURL: 'data:text/plain;base64,aGVsbG8=',
          mimeType: 'text/plain',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(putCalls).toHaveLength(0);
  });

  it('retries a rejected upload until the room accepts it', async () => {
    const putCalls: string[] = [];
    let attempts = 0;
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') {
        putCalls.push(url);
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 500 : 200 });
      }
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['retry-a', 'retry-b']);

    await act(async () => {
      api.addFiles([
        {
          id: 'file-retry',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(putCalls.length).toBeGreaterThanOrEqual(2);
    });
    const accepted = putCalls.length;

    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(putCalls).toHaveLength(accepted);
  });

  it('retries an upload whose request failed', async () => {
    const putCalls: string[] = [];
    let failNext = true;
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') {
        putCalls.push(url);
        if (failNext) {
          failNext = false;
          throw new Error('network down');
        }
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first, second] = await rectangleElements(['throw-a', 'throw-b']);

    await act(async () => {
      api.addFiles([
        {
          id: 'file-throw',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await act(async () => {
      api.updateScene({ elements: [first, second], captureUpdate: CaptureUpdateAction.NEVER });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(putCalls).toHaveLength(2);
  });

  it('fetches a remote image the editor does not hold', async () => {
    const getCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (url.includes('/files/file-remote') && init?.method !== 'PUT') {
        getCalls.push(url);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [image] = await imageElements([{ id: 'img-remote', fileId: 'file-remote' }]);

    seedRemote(remote.doc, remote.array, [image]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(api.getFiles()['file-remote']).toBeTruthy();
    });
    expect(getCalls).toHaveLength(1);
  });

  it('backs off before asking again for an image the room does not have', async () => {
    const getCalls: string[] = [];
    setFetchHandler((url) => {
      if (url.includes('/files/file-missing')) getCalls.push(url);
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [first, second] = await imageElements([
      { id: 'img-1', fileId: 'file-missing' },
      { id: 'img-2', fileId: 'file-missing-2' },
    ]);

    seedRemote(remote.doc, remote.array, [first]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(getCalls).toHaveLength(1);
    });

    await act(async () => {
      seedRemote(remote.doc, remote.array, [first, second]);
      syncFromRemote(doc, remote.doc);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(getCalls.filter((url) => url.includes('file-missing') && !url.includes('file-missing-2')))
      .toHaveLength(1);
  });

  it('does not fetch the same image twice while the first request is in flight', async () => {
    const getCalls: string[] = [];
    let release: ((response: Response) => void) | null = null;
    setFetchHandler((url) => {
      if (url.endsWith('/files/file-slow')) {
        getCalls.push(url);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [first, second] = await imageElements([
      { id: 'img-slow-1', fileId: 'file-slow' },
      { id: 'img-slow-2', fileId: 'file-slow-2' },
    ]);

    seedRemote(remote.doc, remote.array, [first]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    expect(getCalls).toHaveLength(1);

    await act(async () => {
      seedRemote(remote.doc, remote.array, [first, second]);
      syncFromRemote(doc, remote.doc);
    });
    expect(getCalls).toHaveLength(1);

    (release as ((response: Response) => void) | null)?.(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  it('ignores image responses the editor cannot use', async () => {
    const statuses = [403, 200, 200];
    const contentTypes: (string | null)[] = [null, null, 'text/html'];
    let index = 0;
    setFetchHandler((url) => {
      if (url.includes('/files/file-unusable')) {
        const status = statuses[index];
        const contentType = contentTypes[index];
        index += 1;
        const headers = contentType ? { 'content-type': contentType } : undefined;
        return new Response(new Uint8Array([1]), { status, headers });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [image] = await imageElements([{ id: 'img-unusable', fileId: 'file-unusable' }]);

    seedRemote(remote.doc, remote.array, [image]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(index).toBe(1);
    });

    await act(async () => {
      const map = remote.array.toArray()[0];
      map.set('x', (map.get('x') as number) + 1);
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(index).toBe(2);
    });

    await act(async () => {
      const map = remote.array.toArray()[0];
      map.set('x', (map.get('x') as number) + 1);
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(index).toBe(3);
    });

    expect(api.getFiles()['file-unusable']).toBeUndefined();
  });

  it('retries an image fetch that threw', async () => {
    let failNext = true;
    const getCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (url.includes('/files/file-throw') && init?.method !== 'PUT') {
        getCalls.push(url);
        if (failNext) {
          failNext = false;
          throw new Error('network down');
        }
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [image] = await imageElements([{ id: 'img-throw', fileId: 'file-throw' }]);

    seedRemote(remote.doc, remote.array, [image]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(getCalls).toHaveLength(1);
    });

    await act(async () => {
      const map = remote.array.toArray()[0];
      map.set('x', (map.get('x') as number) + 1);
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(api.getFiles()['file-throw']).toBeTruthy();
    });
    expect(getCalls).toHaveLength(2);
  });

  it('leaves an image alone when the editor already holds it', async () => {
    const getCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (url.includes('/files/') && init?.method !== 'PUT') getCalls.push(url);
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [image] = await imageElements([{ id: 'img-held', fileId: 'file-held' }]);

    await act(async () => {
      api.addFiles([
        {
          id: 'file-held',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    seedRemote(remote.doc, remote.array, [image]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(getCalls).toHaveLength(0);
  });

  it('fetches a delayed image when the room announces it is ready', async () => {
    let fileAvailable = false;
    const getCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (url.includes('/files/file-ready') && init?.method !== 'PUT') {
        getCalls.push(url);
        if (!fileAvailable) return new Response(null, { status: 404 });
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();
    const [image] = await imageElements([{ id: 'img-ready', fileId: 'file-ready' }]);

    seedRemote(remote.doc, remote.array, [image]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    await waitFor(() => {
      expect(getCalls).toHaveLength(1);
    });
    expect(api.getFiles()['file-ready']).toBeUndefined();
    // Let the 404 land and the backoff be recorded, so the second ask has to
    // come from readiness rather than from the first request still running.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // The bytes land later; the uploader announces it. No element change and
    // no reload: the peer must ask again.
    fileAvailable = true;
    await act(async () => {
      remote.doc.transact(() => {
        remote.doc.getMap('fileReady').set('file-ready', Date.now());
      }, 'file-ready');
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(api.getFiles()['file-ready']).toBeTruthy();
    });
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('uploads the same picture again in a different room', async () => {
    const putRooms: string[] = [];
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') {
        const match = /\/room\/([^/]+)\/files\//.exec(url);
        putRooms.push(match ? match[1] : url);
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({ roomId: 'room-1' });
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first] = await rectangleElements(['room-a']);

    // Same bytes, same content-addressed id, pasted in room-1.
    await act(async () => {
      api.addFiles([
        {
          id: 'file-same',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(putRooms).toContain('room-1');
    });

    // Same component, new room: per-room upload memory must not skip the PUT
    // the new room's bucket still needs, or the second room keeps a placeholder.
    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} roomId="room-2" />);
    });
    const [second] = await rectangleElements(['room-b']);
    await act(async () => {
      api.addFiles([
        {
          id: 'file-same',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [second], captureUpdate: CaptureUpdateAction.NEVER });
    });

    await waitFor(() => {
      expect(putRooms).toContain('room-2');
    });
  });

  it('shows a failed upload with a retry', async () => {
    const putCalls: string[] = [];
    setFetchHandler((url, init) => {
      if (init?.method === 'PUT') {
        putCalls.push(url);
        // Permanent: the room will never take it, so no background timer will
        // save it -- the teacher has to see it and choose to retry.
        return new Response(null, { status: 413 });
      }
      return new Response(null, { status: 404 });
    });
    const { view, api } = await renderWrapper();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [first] = await rectangleElements(['fail-a']);

    await act(async () => {
      api.addFiles([
        {
          id: 'file-fail',
          dataURL: 'data:image/png;base64,aGVsbG8=',
          mimeType: 'image/png',
          created: 1,
        },
      ] as never);
    });
    await act(async () => {
      api.updateScene({ elements: [first], captureUpdate: CaptureUpdateAction.NEVER });
    });

    const status = await view.findByTestId('board-upload-status');
    expect(status.textContent).toMatch(/failed/i);
    const before = putCalls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    const retry = view.getByRole('button', { name: /retry/i });
    await act(async () => {
      retry.click();
    });

    await waitFor(() => {
      expect(putCalls.length).toBeGreaterThan(before);
    });
  });
});

async function libraryItems(ids: string[]): Promise<{ id: string; status: string; created: number; elements: unknown[] }[]> {
  const elements = await rectangleElements(ids.map((id) => `${id}-el`));
  return ids.map((id, index) => ({
    id,
    status: 'published',
    created: 1,
    elements: [elements[index]],
  }));
}

describe('ExcalidrawWrapper room library', () => {
  it('loads the room library and asks for the pictures it refers to', async () => {
    const fileGets: string[] = [];
    const [element] = await imageElements([{ id: 'lib-img', fileId: 'file-lib' }]);
    const items = [{ id: 'lib-1', status: 'published', created: 1, elements: [element] }];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library')) return jsonResponse({ items });
      if (url.includes('/files/file-lib') && init?.method !== 'PUT') {
        fileGets.push(url);
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();

    await waitFor(() => {
      expect(fileGets).toHaveLength(1);
    });
    expect(api.getFiles()['file-lib']).toBeTruthy();
  });

  it('treats a library body that is not a list as empty', async () => {
    const fileGets: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library')) return jsonResponse({ items: 'nope' });
      if (url.includes('/files/') && init?.method !== 'PUT') fileGets.push(url);
      return new Response(null, { status: 404 });
    });
    await renderWrapper();
    await settleApiReady();

    expect(fileGets).toHaveLength(0);
  });

  it('reports a failed library load and refuses to save over it', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return new Response(null, { status: 500 });
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-failed']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(posts).toHaveLength(0);
  });

  it('survives a library request that fails outright', async () => {
    setFetchHandler((url) => {
      if (url.endsWith('/library')) throw new Error('network down');
      return new Response(null, { status: 404 });
    });
    const { view } = await renderWrapper();
    await settleApiReady();

    expect(view.container.querySelector('.excalidraw')).toBeTruthy();
  });

  it('cancels a pending library load when the board unmounts', async () => {
    let release: ((response: Response) => void) | null = null;
    setFetchHandler((url) => {
      if (url.endsWith('/library')) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });
    const { view } = await renderWrapper();
    await settleApiReady();

    await act(async () => {
      view.unmount();
    });
    (release as ((response: Response) => void) | null)?.(jsonResponse({ items: [] }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  it('saves the room library after it has loaded', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-saved']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
    });

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    }, { timeout: 2500 });
    expect(posts[0]).toContain('lib-saved');
  });

  it('debounces library saves into one request', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const first = await libraryItems(['lib-first']);
    const second = await libraryItems(['lib-second']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: first as never, merge: false });
      await api.updateLibrary({ libraryItems: second as never, merge: false });
    });

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    }, { timeout: 2500 });
    expect(posts[0]).toContain('lib-second');
  });

  it('does not save the library for a peer', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper({ isLocalHost: false });
    await settleApiReady();
    const items = await libraryItems(['lib-peer']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(posts).toHaveLength(0);
  });

  it('does not save the library before it has loaded', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) {
        return new Promise<Response>((resolve) => {
          void resolve;
        });
      }
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-pending']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(posts).toHaveLength(0);
  });

  it('flushes a pending library save when the board unmounts', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { view, api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-unmount']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
    });
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('lib-unmount');
  });

  it('sends a pending library save when the page is hidden, so leaving the room keeps it', async () => {
    const posts: Array<{ body: string; keepalive: boolean }> = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push({ body: String(init.body), keepalive: init.keepalive === true });
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-pagehide']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
    });

    // Leaving the room is a full page navigation in the built app, so the
    // pending save has to go out while the document goes away.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('lib-pagehide');
    expect(posts[0].keepalive).toBe(true);
  });

  it('does not save the library twice when unmounting after the save fired', async () => {
    const posts: string[] = [];
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') {
        posts.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { view, api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-late-unmount']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
    });
    await waitFor(() => {
      expect(posts).toHaveLength(1);
    }, { timeout: 2500 });
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(posts).toHaveLength(1);
  });
});

describe('ExcalidrawWrapper guiding scroll', () => {
  it('debounces guided viewport sends while the board moves', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onGuideViewport = vi.fn();
    const { api } = await renderWrapper({ onGuideViewport, isGuiding: true });
    await settleApiReady();

    await act(async () => {
      api.updateScene({ appState: { scrollX: 5 } });
    });
    await act(async () => {
      api.updateScene({ appState: { scrollX: 9 } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    await waitFor(() => {
      expect(onGuideViewport).toHaveBeenCalledWith({ x: 9, y: 0, zoom: 1 });
    });
  });

  it('drops a pending guided send when guiding stops', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onGuideViewport = vi.fn();
    const { view, props, ExcalidrawWrapper, api } = await renderWrapper({
      onGuideViewport,
      isGuiding: true,
    });
    await settleApiReady();
    onGuideViewport.mockClear();

    await act(async () => {
      api.updateScene({ appState: { scrollX: 5 } });
    });
    await act(async () => {
      view.rerender(<ExcalidrawWrapper {...props} isGuiding={false} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(onGuideViewport).not.toHaveBeenCalled();
  });

  it('clears a pending guided send when the board unmounts', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { api, view } = await renderWrapper({ isGuiding: true });
    await settleApiReady();

    await act(async () => {
      api.updateScene({ appState: { scrollX: 5 } });
    });
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  });

  it('falls back to the Teacher name when the host is not in the roster', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const student = { peerId: 'peer-2', userName: 'Student', color: '#112233', isHost: false };
    const { view, props, api, ExcalidrawWrapper } = await renderWrapper({
      users: [student],
      hostPeerId: 'host-1',
    });
    await settleApiReady();

    await act(async () => {
      view.rerender(
        <ExcalidrawWrapper
          {...props}
          guideMessage={{ active: true, viewport: { x: 1, y: 2, zoom: 1 } }}
        />,
      );
    });

    await waitFor(() => {
      expect(api.getAppState().userToFollow?.username).toBe('Teacher');
    });
    expect(api.getAppState().userToFollow?.socketId).toBe('host-1');
  });

  it('reports a custom editor tool as it is named', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const onToolChange = vi.fn();
    const { api } = await renderWrapper({ onToolChange });
    await settleApiReady();

    await act(async () => {
      api.setActiveTool({ type: 'custom', customType: 'stamp' } as never);
    });

    await waitFor(() => {
      expect(onToolChange).toHaveBeenCalledWith('custom');
    });
  });
});

describe('ExcalidrawWrapper remote coalescing and reconciliation', () => {
  it('hops a coalesced remote scene to the room after the flush delay', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const onElementsChange = vi.fn();
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array, onElementsChange });
    const [rectangle] = await rectangleElements(['rect-hop']);

    seedRemote(remote.doc, remote.array, [rectangle]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(
        onElementsChange.mock.calls.some(([elements]) =>
          (elements as { id: string }[]).some((element) => element.id === 'rect-hop'),
        ),
      ).toBe(true);
    }, { timeout: 2000 });
    expect(api.getSceneElements().some((element) => element.id === 'rect-hop')).toBe(true);
  });

  it('skips latency events for remote elements without an id or version', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    await renderWrapper({ yDoc: doc, yElementsArray: array });
    const [first, second] = await rectangleElements(['latency-a', 'latency-b']);
    clearWhiteboardLatencyEvents();

    seedRemote(remote.doc, remote.array, [first]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });

    const withoutId = new Y.Map<unknown>();
    withoutId.set('type', 'rectangle');
    await act(async () => {
      seedRemote(remote.doc, remote.array, [first, second]);
      remote.array.push([withoutId]);
      syncFromRemote(doc, remote.doc);
    });

    await waitFor(() => {
      expect(
        readWhiteboardLatencyEvents().some(
          (event) => event.kind === 'stroke-render' && event.elementId === 'latency-b',
        ),
      ).toBe(true);
    });
    expect(
      readWhiteboardLatencyEvents().some(
        (event) => event.kind === 'stroke-render' && (event.elementId ?? '').length === 0,
      ),
    ).toBe(false);
  });

  it('keeps an unpublished local element while a pointer is down', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [dummy, localOnly, remoteRect] = await rectangleElements(['dummy', 'local-only', 'remote-wins']);
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });
    const canvas = interactiveCanvas();

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', { buttons: 1 }));
      api.updateScene({ elements: [dummy], captureUpdate: CaptureUpdateAction.NEVER });
      api.updateScene({ elements: [dummy, localOnly], captureUpdate: CaptureUpdateAction.NEVER });
      seedRemote(remote.doc, remote.array, [remoteRect]);
      syncFromRemote(doc, remote.doc);
    });

    expect(api.getSceneElements().some((element) => element.id === 'local-only')).toBe(true);
    expect(api.getSceneElements().some((element) => element.id === 'remote-wins')).toBe(true);
  });

  it('treats a same-version payload from a peer as a change', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [rectangle] = await rectangleElements(['rect-payload']);
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array });

    await act(async () => {
      api.updateScene({ elements: [rectangle], captureUpdate: CaptureUpdateAction.NEVER });
    });
    await waitFor(() => {
      expect(array.toArray()).toHaveLength(1);
    });

    await act(async () => {
      api.updateScene({
        elements: [{ ...rectangle, x: rectangle.x + 33 }],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });

    seedRemote(remote.doc, remote.array, [{ ...rectangle, x: rectangle.x + 99 }]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });

    expect(api.getSceneElements().some((element) => element.id === 'rect-payload')).toBe(true);
  });
});

describe('ExcalidrawWrapper remote image and library races', () => {
  it('does not re-ask for a library image whose fetch is in flight', async () => {
    const getCalls: string[] = [];
    let releaseFile: ((response: Response) => void) | null = null;
    let releaseLibrary: ((response: Response) => void) | null = null;
    const [element] = await imageElements([{ id: 'race-img', fileId: 'file-race' }]);
    const items = [{ id: 'race-lib', status: 'published', created: 1, elements: [element] }];
    setFetchHandler((url) => {
      if (url.endsWith('/library')) {
        return new Promise<Response>((resolve) => {
          releaseLibrary = resolve;
        });
      }
      if (url.endsWith('/files/file-race')) {
        getCalls.push(url);
        return new Promise<Response>((resolve) => {
          releaseFile = resolve;
        });
      }
      return new Response(null, { status: 404 });
    });
    const { doc, array } = createYjsBoard();
    const remote = remoteBoard();
    await renderWrapper({ yDoc: doc, yElementsArray: array });
    await settleApiReady();

    seedRemote(remote.doc, remote.array, [element]);
    await act(async () => {
      syncFromRemote(doc, remote.doc);
    });
    expect(getCalls).toHaveLength(1);

    await act(async () => {
      (releaseLibrary as ((response: Response) => void) | null)?.(jsonResponse({ items }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getCalls).toHaveLength(1);

    (releaseFile as ((response: Response) => void) | null)?.(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  it('cancels a library load that answers after the board unmounts', async () => {
    let releaseJson: (() => void) | null = null;
    setFetchHandler((url) => {
      if (url.endsWith('/library')) {
        const response = new Response('{"items":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(response, 'json', {
          value: () =>
            new Promise((resolve) => {
              releaseJson = () => resolve({ items: [] });
            }),
        });
        return response;
      }
      return new Response(null, { status: 404 });
    });
    const { view } = await renderWrapper();
    await settleApiReady();

    await act(async () => {
      view.unmount();
    });
    (releaseJson as (() => void) | null)?.();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  it('does not expose the debug API outside development and e2e builds', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_E2E', '');
    setFetchHandler(() => new Response(null, { status: 404 }));
    const ExcalidrawWrapper = await loadExcalidrawWrapper();
    const props = createProps();

    await act(async () => {
      render(<ExcalidrawWrapper {...props} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(window.__debugExcalidrawApi).toBeUndefined();
  });

  it('renders remote cursors and records cursor latency', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const cursors = [
      { peerId: 'peer-2', userName: 'Bob', color: '#123456', x: 5, y: 6, button: 'up' as const },
    ];
    const users = [{ peerId: 'peer-2', userName: 'Bob', color: '#123456', isHost: false }];
    clearWhiteboardLatencyEvents();
    const { api } = await renderWrapper({ cursors, users });
    await settleApiReady();

    await waitFor(() => {
      expect(
        readWhiteboardLatencyEvents().some(
          (event) => event.kind === 'cursor-render' && event.peerId === 'peer-2',
        ),
      ).toBe(true);
    });
    expect(api.getAppState().collaborators.size).toBeGreaterThan(0);
  });

  it('survives a library save that fails in flight', async () => {
    setFetchHandler((url, init) => {
      if (url.endsWith('/library') && init?.method === 'POST') throw new Error('network down');
      if (url.endsWith('/library')) return jsonResponse({ items: [] });
      return new Response(null, { status: 404 });
    });
    const { api } = await renderWrapper();
    await settleApiReady();
    const items = await libraryItems(['lib-save-fail']);

    await act(async () => {
      await api.updateLibrary({ libraryItems: items as never, merge: false });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
  });
});

describe('multiple boards', () => {
  function seedTwoBoards(doc: Y.Doc, array: Y.Array<Y.Map<unknown>>): void {
    replaceSharedElements(doc, array, [
      { id: 'main-1', type: 'rectangle', boardId: 'main' },
      { id: 'b2-1', type: 'rectangle', boardId: 'board-2' },
    ] as never, 'seed');
  }

  function sceneIds(api: { getSceneElements: () => readonly unknown[] }): string[] {
    return (api.getSceneElements() as readonly { id: string }[]).map((element) => element.id);
  }

  it('stamps elements drawn on the active board with its id', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { props, api } = await renderWrapper({ activeBoardId: 'board-2' });
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [el] = await rectangleElements(['board2-el']);
    await act(async () => {
      api.updateScene({ elements: [el], captureUpdate: CaptureUpdateAction.NEVER });
    });

    const stored = getElementsFromArray(props.yElementsArray!);
    expect((stored.find((element) => element.id === 'board2-el') as { boardId?: unknown } | undefined)?.boardId).toBe('board-2');
  });

  it('renders only the elements of the active board', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    seedTwoBoards(doc, array);
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array, activeBoardId: 'board-2' });

    await waitFor(() => {
      expect(sceneIds(api)).toEqual(['b2-1']);
    });
  });

  it('switching boards swaps the scene and keeps the other board in the document', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    seedTwoBoards(doc, array);
    const { view, props, api, ExcalidrawWrapper: Wrapper } = await renderWrapper({ yDoc: doc, yElementsArray: array, activeBoardId: 'main' });
    await waitFor(() => {
      expect(sceneIds(api)).toEqual(['main-1']);
    });

    await act(async () => {
      view.rerender(<Wrapper {...props} activeBoardId="board-2" />);
    });

    await waitFor(() => {
      expect(sceneIds(api)).toEqual(['b2-1']);
    });
    // The board that was left is still in the shared document.
    expect(getElementsFromArray(array).map((element) => element.id)).toEqual(['main-1', 'b2-1']);
  });

  it('erasing on the active board tombstones locally and leaves other boards untouched', async () => {
    setFetchHandler(() => new Response(null, { status: 404 }));
    const { doc, array } = createYjsBoard();
    seedTwoBoards(doc, array);
    const { api } = await renderWrapper({ yDoc: doc, yElementsArray: array, activeBoardId: 'board-2' });
    await waitFor(() => {
      expect(sceneIds(api)).toEqual(['b2-1']);
    });

    // Erase the way Excalidraw reports it: the element stays in the scene as
    // a version-bumped tombstone rather than vanishing from it.
    const { CaptureUpdateAction } = await loadExcalidrawPackage();
    const [erased] = await rectangleElements(['b2-1']);
    await act(async () => {
      api.updateScene({
        elements: [{ ...erased, isDeleted: true, version: 5 }],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });

    await waitFor(() => {
      expect(sceneIds(api)).toEqual([]);
    });
    const stored = getElementsFromArray(array);
    expect((stored.find((element) => element.id === 'b2-1') as { isDeleted?: unknown } | undefined)?.isDeleted).toBe(true);
    // The main board's element is untouched by board 2's erase.
    expect((stored.find((element) => element.id === 'main-1') as { isDeleted?: unknown } | undefined)?.isDeleted).toBeFalsy();
  });
});
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PenTool from '@/components/whiteboard/tools/PenTool';
import RectangleTool from '@/components/whiteboard/tools/RectangleTool';
import CircleTool from '@/components/whiteboard/tools/CircleTool';
import LineTool from '@/components/whiteboard/tools/LineTool';
import ArrowTool from '@/components/whiteboard/tools/ArrowTool';
import TextTool from '@/components/whiteboard/tools/TextTool';
import StickyNoteTool from '@/components/whiteboard/tools/StickyNoteTool';
import EraserTool from '@/components/whiteboard/tools/EraserTool';
import { getCanvasPointer } from '@/components/whiteboard/tools/pointer';
import * as store from '@/lib/whiteboard/store';
import { toolHandlers } from '@/components/whiteboard/ToolEvents';
import { useWhiteboardStore } from '@/hooks/useWhiteboardStore';

vi.mock('@/hooks/useWhiteboardStore', () => ({
  useWhiteboardStore: vi.fn(),
}));

vi.mock('@/lib/whiteboard/store', () => ({
  addElement: vi.fn(),
  updateElement: vi.fn(),
  removeElement: vi.fn(),
  selectElement: vi.fn(),
  selectMultiple: vi.fn(),
  deselectAll: vi.fn(),
  setTool: vi.fn(),
  setPalette: vi.fn(),
  setViewport: vi.fn(),
  setElements: vi.fn(),
  moveElement: vi.fn(),
  duplicateElement: vi.fn(),
  bringForward: vi.fn(),
  sendBackward: vi.fn(),
  bringToFront: vi.fn(),
  sendToBack: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: vi.fn(() => false),
  canRedo: vi.fn(() => false),
  pushHistorySnapshot: vi.fn(),
  setCurrentElement: vi.fn(),
  getState: vi.fn(() => ({
    elements: [],
    selectedIds: [],
    tool: 'select',
    palette: { color: '#000000', strokeWidth: 2, fill: 'transparent' },
    viewport: { x: 0, y: 0, zoom: 1 },
    selectionRect: null,
  })),
  subscribe: vi.fn(() => () => {}),
}));

function mockStore(state: any) {
  (useWhiteboardStore as any).mockReturnValue(state);
}

function konvaEvent(pointer: { x: number; y: number }) {
  return {
    evt: { clientX: pointer.x + 56, clientY: pointer.y + 48 },
    target: {
      getStage: () => ({
        getPointerPosition: () => pointer,
        container: () => ({
          getBoundingClientRect: () => ({ left: 56, top: 48 }),
        }),
      }),
    },
  };
}

describe('getCanvasPointer', () => {
  it('uses Konva pointer coordinates instead of viewport client coordinates', () => {
    expect(
      getCanvasPointer(konvaEvent({ x: 140, y: 120 }), { x: 0, y: 0, zoom: 1 })
    ).toEqual({ x: 140, y: 120 });
  });
});

describe('PenTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not pen', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<PenTool />);
    expect(container.innerHTML).toBe('');
  });

  it('calls setCurrentElement on onMouseMove when drawing pen preview', () => {
    const mockAddElement = vi.fn();
    const mockSetCurrentElement = vi.fn();
    mockStore({
      elements: [],
      addElement: mockAddElement,
      setCurrentElement: mockSetCurrentElement,
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'pen',
    });

    render(<PenTool />);

    const handlers = toolHandlers.current;
    expect(handlers.toolType).toBe('pen');

    // Trigger drag
    handlers.onMouseDown({ evt: { clientX: 10, clientY: 20 } });
    handlers.onMouseMove({ evt: { clientX: 15, clientY: 25 } });

    expect(mockSetCurrentElement).toHaveBeenCalled();
  });
});

describe('RectangleTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not rectangle', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      setCurrentElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2, fill: 'transparent' },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<RectangleTool />);
    expect(container.innerHTML).toBe('');
  });

  it('calls setCurrentElement on onMouseMove when drawing rectangle preview', () => {
    const mockAddElement = vi.fn();
    const mockSetCurrentElement = vi.fn();
    mockStore({
      elements: [],
      addElement: mockAddElement,
      setCurrentElement: mockSetCurrentElement,
      palette: { color: '#000000', strokeWidth: 2, fill: 'transparent' },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'rectangle',
    });

    render(<RectangleTool />);

    // Get registered handlers
    const handlers = toolHandlers.current;
    expect(handlers.toolType).toBe('rectangle');

    // Trigger drag
    handlers.onMouseDown({ evt: { clientX: 10, clientY: 20 } });
    handlers.onMouseMove({ evt: { clientX: 50, clientY: 70 } });

    // Assert that live preview currentElement was set
    expect(mockSetCurrentElement).toHaveBeenCalled();
  });
});

describe('CircleTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not circle', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2, fill: 'transparent' },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<CircleTool />);
    expect(container.innerHTML).toBe('');
  });

  it('calls setCurrentElement on onMouseMove when drawing circle preview', () => {
    const mockAddElement = vi.fn();
    const mockSetCurrentElement = vi.fn();
    mockStore({
      elements: [],
      addElement: mockAddElement,
      setCurrentElement: mockSetCurrentElement,
      palette: { color: '#000000', strokeWidth: 2, fill: 'transparent' },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'circle',
    });

    render(<CircleTool />);

    const handlers = toolHandlers.current;
    expect(handlers.toolType).toBe('circle');

    handlers.onMouseDown({ evt: { clientX: 10, clientY: 20 } });
    handlers.onMouseMove({ evt: { clientX: 50, clientY: 70 } });

    expect(mockSetCurrentElement).toHaveBeenCalled();
  });
});

describe('LineTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not line', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<LineTool />);
    expect(container.innerHTML).toBe('');
  });

  it('calls setCurrentElement on onMouseMove when drawing line preview', () => {
    const mockAddElement = vi.fn();
    const mockSetCurrentElement = vi.fn();
    mockStore({
      elements: [],
      addElement: mockAddElement,
      setCurrentElement: mockSetCurrentElement,
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'line',
    });

    render(<LineTool />);

    const handlers = toolHandlers.current;
    expect(handlers.toolType).toBe('line');

    handlers.onMouseDown({ evt: { clientX: 10, clientY: 20 } });
    handlers.onMouseMove({ evt: { clientX: 50, clientY: 70 } });

    expect(mockSetCurrentElement).toHaveBeenCalled();
  });
});

describe('ArrowTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not arrow', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<ArrowTool />);
    expect(container.innerHTML).toBe('');
  });

  it('calls setCurrentElement on onMouseMove when drawing arrow preview', () => {
    const mockAddElement = vi.fn();
    const mockSetCurrentElement = vi.fn();
    mockStore({
      elements: [],
      addElement: mockAddElement,
      setCurrentElement: mockSetCurrentElement,
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'arrow',
    });

    render(<ArrowTool />);

    const handlers = toolHandlers.current;
    expect(handlers.toolType).toBe('arrow');

    handlers.onMouseDown({ evt: { clientX: 10, clientY: 20 } });
    handlers.onMouseMove({ evt: { clientX: 50, clientY: 70 } });

    expect(mockSetCurrentElement).toHaveBeenCalled();
  });
});

describe('TextTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not text', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      palette: { color: '#000000', strokeWidth: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<TextTool />);
    expect(container.innerHTML).toBe('');
  });
});

describe('StickyNoteTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not stickyNote', () => {
    mockStore({
      elements: [],
      addElement: vi.fn(),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<StickyNoteTool />);
    expect(container.innerHTML).toBe('');
  });
});

describe('EraserTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tool is not eraser', () => {
    mockStore({
      elements: [],
      removeElement: vi.fn(),
      viewport: { x: 0, y: 0, zoom: 1 },
      tool: 'select',
    });
    const { container } = render(<EraserTool />);
    expect(container.innerHTML).toBe('');
  });
});

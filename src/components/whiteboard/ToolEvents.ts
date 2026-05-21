type Handler = (e: any) => void;

interface ToolHandlers {
  toolType: string | null;
  onMouseDown: Handler | null;
  onMouseMove: Handler | null;
  onMouseUp: Handler | null;
  onClick: Handler | null;
}

const registry: { current: ToolHandlers } = {
  current: { toolType: null, onMouseDown: null, onMouseMove: null, onMouseUp: null, onClick: null },
};

export function registerToolHandlers(handlers: Partial<ToolHandlers> & { toolType: string }) {
  registry.current = {
    toolType: handlers.toolType,
    onMouseDown: handlers.onMouseDown ?? null,
    onMouseMove: handlers.onMouseMove ?? null,
    onMouseUp: handlers.onMouseUp ?? null,
    onClick: handlers.onClick ?? null,
  };
}

export function clearToolHandlers() {
  registry.current = { toolType: null, onMouseDown: null, onMouseMove: null, onMouseUp: null, onClick: null };
}

export const toolHandlers = registry;

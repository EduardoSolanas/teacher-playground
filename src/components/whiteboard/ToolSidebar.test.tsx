import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ToolSidebar from './ToolSidebar';

describe('ToolSidebar guide control', () => {
  it('shows the host-only guide toggle and changes its label', () => {
    let toggleCalls = 0;
    const onToggleGuide = () => { toggleCalls += 1; };
    const { rerender } = render(
      <ToolSidebar
        activeTool="select"
        onToolChange={() => {}}
        onOpenLibrary={() => {}}
        onOpenHelp={() => {}}
        showHostTools
        isGuiding={false}
        onToggleGuide={onToggleGuide}
      />,
    );

    expect(screen.getByTestId('whiteboard-tool-guide').getAttribute('aria-label')).toBe('Guide class');
    fireEvent.click(screen.getByTestId('whiteboard-tool-guide'));
    expect(toggleCalls).toBe(1);

    rerender(
      <ToolSidebar
        activeTool="select"
        onToolChange={() => {}}
        onOpenLibrary={() => {}}
        onOpenHelp={() => {}}
        showHostTools
        isGuiding
        onToggleGuide={onToggleGuide}
      />,
    );
    expect(screen.getByTestId('whiteboard-tool-guide').getAttribute('aria-label')).toBe('Stop guiding');
  });
});

describe('ToolSidebar placement', () => {
  it('sits centred along the bottom at every size', () => {
    /*
     * The middle of the bottom edge is free now that undo, redo and Clear
     * have moved into Excalidraw's footer, and a centred horizontal bar is
     * the shape a phone has always had here -- so the desktop stops being the
     * odd one out, and the board stops losing a column down its left edge.
     */
    render(
      <ToolSidebar
        activeTool="select"
        onToolChange={() => {}}
        onOpenLibrary={() => {}}
        onOpenHelp={() => {}}
        showHostTools
        isGuiding={false}
        onToggleGuide={() => {}}
      />,
    );

    const bar = screen.getByTestId('whiteboard-tool-bar');
    expect(bar.className).toContain('justify-center');
    expect(bar.className).not.toContain('sm:flex-col');
    expect(bar.className).not.toContain('sm:top-0');
    expect(bar.className).not.toContain('sm:left-0');
  });
});

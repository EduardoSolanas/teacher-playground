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

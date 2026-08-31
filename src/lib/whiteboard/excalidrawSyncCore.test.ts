import { describe, expect, it } from 'vitest';

import { isMappedAppTool, toExcalidrawToolType } from './excalidrawSyncCore';

describe('isMappedAppTool', () => {
  it('knows the tools this application names', () => {
    expect(isMappedAppTool('rectangle')).toBe(true);
    expect(isMappedAppTool('circle')).toBe(true);
    expect(isMappedAppTool('pen')).toBe(true);
  });

  it('does not claim the tools only Excalidraw has', () => {
    /*
     * The reason this predicate exists. `toExcalidrawToolType` answers
     * `selection` for anything it does not know, which is right for asking
     * what to display and wrong for pushing back into the editor: diamond was
     * reported by Excalidraw, mapped to `selection` on the way out and sent
     * straight back, so the tool bounced to the arrow a moment after it was
     * picked. Everything here must be left alone rather than translated.
     */
    for (const tool of ['diamond', 'image', 'frame', 'laser', 'hand', 'embeddable']) {
      expect(isMappedAppTool(tool)).toBe(false);
      expect(toExcalidrawToolType(tool)).toBe('selection');
    }
  });

  it('is not fooled by names inherited from Object', () => {
    expect(isMappedAppTool('constructor')).toBe(false);
    expect(isMappedAppTool('toString')).toBe(false);
  });
});

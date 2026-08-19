import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomSceneSaveDebounceMs } from './persistDebounce';

describe('roomSceneSaveDebounceMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a short delay in e2e so HTTP catch-up can finish inside the spec timeout', () => {
    vi.stubEnv('NEXT_PUBLIC_E2E', '1');
    expect(roomSceneSaveDebounceMs()).toBe(250);
  });

  it('keeps the production debounce otherwise', () => {
    vi.stubEnv('NEXT_PUBLIC_E2E', '');
    expect(roomSceneSaveDebounceMs()).toBe(3000);
  });
});

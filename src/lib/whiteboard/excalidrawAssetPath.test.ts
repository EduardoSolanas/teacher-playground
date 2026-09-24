import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXCALIDRAW_ASSET_ORIGIN,
  EXCALIDRAW_CDN_BASE_PATH,
  EXCALIDRAW_ASSET_PATH,
  resolveExcalidrawAssetPath,
} from './excalidrawAssetPath';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH;
});

describe('Excalidraw asset distribution', () => {
  it('pins the production fork release to the immutable CDN directory', () => {
    expect(EXCALIDRAW_CDN_BASE_PATH).toBe(
      'https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.12/dist/prod/',
    );
    expect(EXCALIDRAW_ASSET_PATH).toBe('/');
    expect(EXCALIDRAW_ASSET_PATH.endsWith('/')).toBe(true);
    expect(EXCALIDRAW_ASSET_ORIGIN).toBe(null);
    expect(resolveExcalidrawAssetPath({ NODE_ENV: 'production' })).toBe(EXCALIDRAW_CDN_BASE_PATH);
    expect(resolveExcalidrawAssetPath({ NODE_ENV: 'development' })).toBe('/');
    expect(resolveExcalidrawAssetPath({
      NODE_ENV: 'production',
      NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH: 'https://preview.example/assets/',
    })).toBe('https://preview.example/assets/');
  });

  it('reads the environment through its default parameter', () => {
    vi.stubEnv('NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH', 'https://stub.example/assets/');

    expect(resolveExcalidrawAssetPath()).toBe('https://stub.example/assets/');
  });

  it('derives the asset origin and the window handle from an absolute path at import', async () => {
    vi.stubEnv('NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH', 'https://cdn.example/assets/');

    const mod = await import('./excalidrawAssetPath');

    expect(mod.EXCALIDRAW_ASSET_ORIGIN).toBe('https://cdn.example');
    expect((window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH)
      .toBe('https://cdn.example/assets/');
  });

  it('leaves the asset origin null for a relative path', async () => {
    vi.stubEnv('NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH', '');

    const mod = await import('./excalidrawAssetPath');

    expect(mod.EXCALIDRAW_ASSET_ORIGIN).toBe(null);
    expect(mod.EXCALIDRAW_ASSET_PATH).toBe('');
  });
});

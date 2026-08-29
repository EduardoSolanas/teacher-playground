import { describe, expect, it } from 'vitest';

import {
  EXCALIDRAW_ASSET_ORIGIN,
  EXCALIDRAW_CDN_BASE_PATH,
  EXCALIDRAW_ASSET_PATH,
  resolveExcalidrawAssetPath,
} from './excalidrawAssetPath';

describe('Excalidraw asset distribution', () => {
  it('pins the production fork release to the immutable CDN directory', () => {
    expect(EXCALIDRAW_CDN_BASE_PATH).toBe(
      'https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.9/dist/prod/',
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
});

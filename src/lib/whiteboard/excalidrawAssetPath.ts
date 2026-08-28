/**
 * Point Excalidraw at the immutable fork release hosted by Cloudflare R2.
 *
 * Left unset, Excalidraw resolves those against its public CDN, and `font-src`
 * carries no third-party origin — so every font request is refused and the
 * handwriting font never loads.
 *
 * This lives in its own module, imported BEFORE `@teacher-playground/excalidraw`,
 * because ES module imports are evaluated before the importing module's body.
 * Assigning this at the top of the component file ran too late: Excalidraw had
 * already initialised and read the path. Import order is the mechanism, so keep
 * this import first.
 *
 * The local fallback remains available when this module is evaluated outside a
 * production build (for example, local development and preview builds).
 */
export const EXCALIDRAW_CDN_BASE_PATH =
  'https://excalidraw-assets.sen-tutor.co.uk/releases/0.18.1-tp.6/dist/prod/';

export function resolveExcalidrawAssetPath(env: {
  NODE_ENV?: string;
  NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH?: string;
} = process.env): string {
  return env.NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH
    ?? (env.NODE_ENV === 'production' ? EXCALIDRAW_CDN_BASE_PATH : '/');
}

export const EXCALIDRAW_ASSET_PATH = resolveExcalidrawAssetPath();

export const EXCALIDRAW_ASSET_ORIGIN = EXCALIDRAW_ASSET_PATH.startsWith('http')
  ? new URL(EXCALIDRAW_ASSET_PATH).origin
  : null;

if (typeof window !== 'undefined') {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}

export {};

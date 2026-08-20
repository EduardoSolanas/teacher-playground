/**
 * Point Excalidraw at the fonts and locales vendored in `public/excalidraw-assets`.
 *
 * Left unset, Excalidraw resolves those against its public CDN, and `font-src`
 * carries no third-party origin — so every font request is refused and the
 * handwriting font never loads.
 *
 * This lives in its own module, imported BEFORE `@excalidraw/excalidraw`,
 * because ES module imports are evaluated before the importing module's body.
 * Assigning this at the top of the component file ran too late: Excalidraw had
 * already initialised and read the path. Import order is the mechanism, so keep
 * this import first.
 *
 * Excalidraw appends "excalidraw-assets/" to the value, so "/" resolves to the
 * path the Worker routing already allows on every hostname.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';
}

export {};

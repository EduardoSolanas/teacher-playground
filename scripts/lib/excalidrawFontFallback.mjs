/**
 * Point Excalidraw's font fallback at our own origin.
 *
 * Excalidraw resolves every font to two candidates: one under
 * `window.EXCALIDRAW_ASSET_PATH`, and one under a hardcoded
 * `ASSETS_FALLBACK_URL` of https://esm.sh/@excalidraw/excalidraw@VERSION/dist/prod/.
 *
 * We set the asset path and copy the fonts into public/, which is what the
 * documented self-hosting recipe asks for — and every font is still requested
 * from esm.sh, never once from our origin. That is excalidraw/excalidraw#8228,
 * open and unfixed: the variable is not respected. The result was ~220 blocked
 * requests per room against `font-src 'self' data: blob:`, Excalidraw's
 * typefaces never rendering, and every pupil's browser reaching a third-party
 * CDN to draw on a whiteboard.
 *
 * So the fallback itself is rewritten to our origin at build time. Both
 * candidates then resolve locally and the CDN is never consulted, whether or
 * not upstream honours the variable.
 */

/** Matches the assignment of the CDN base, including its nested template. */
const FALLBACK_ASSIGNMENT = /(["']ASSETS_FALLBACK_URL["']\s*,\s*)`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g;

/** What we put in its place: this page's own origin, read at runtime. */
export const LOCAL_FALLBACK = '`${globalThis.location.origin}/`';

/** True when a source has already been rewritten. */
export function isPatched(source) {
  return source.includes(`ASSETS_FALLBACK_URL",${LOCAL_FALLBACK}`)
    || source.includes(`'ASSETS_FALLBACK_URL',${LOCAL_FALLBACK}`);
}

/**
 * Rewrite the CDN fallback to the local origin.
 *
 * Returns the new source and how many assignments were replaced. A caller that
 * gets 0 on an unpatched file must fail the build rather than continue: a
 * silent no-op here puts every font back on the CDN, which is the bug this
 * exists to prevent and is invisible until someone opens a console.
 */
export function patchAssetsFallback(source) {
  if (isPatched(source)) return { source, replaced: 0, alreadyPatched: true };
  let replaced = 0;
  const patched = source.replace(FALLBACK_ASSIGNMENT, (_full, assignment) => {
    replaced += 1;
    return `${assignment}${LOCAL_FALLBACK}`;
  });
  return { source: patched, replaced, alreadyPatched: false };
}

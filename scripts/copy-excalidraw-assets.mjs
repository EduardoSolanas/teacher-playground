#!/usr/bin/env node
/**
 * Copy Excalidraw's runtime assets into public/ before a build.
 *
 * Excalidraw fetches these at runtime rather than bundling them. Its resolver
 * strips the leading slash from paths like "./fonts/Xiaolai/…woff2" and
 * resolves them against `window.EXCALIDRAW_ASSET_PATH`, which we set to "/" in
 * the root layout — so they must be served from /fonts and /data.
 *
 * Left uncopied, Excalidraw falls back to its public CDN, and `font-src` has no
 * third-party origin: every request is refused and the handwriting font never
 * loads (209 CJK subsets, reported ~230 times on a single board).
 *
 * Copied at build time rather than committed because the file names are
 * content-hashed per Excalidraw release, so a vendored copy silently goes stale
 * on upgrade — which is exactly what happened: public/excalidraw-assets held
 * the 0.17 layout, which 0.18 no longer looks for.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPatched, patchAssetsFallback } from './lib/excalidrawFontFallback.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod');
const publicDir = join(root, 'public');

if (!existsSync(source)) {
  console.error(`Excalidraw assets not found at ${source}. Run npm install first.`);
  process.exit(1);
}

/*
 * Fonts we do not ship.
 *
 * Xiaolai is the handwriting face for CJK text: 209 subset files and 13MB of
 * the 14MB under public/fonts, fetched one subset per glyph range — the ~230
 * requests a single board was reported making. Nothing in this product is
 * taught in Chinese, Japanese or Korean, so the cost is paid on every deploy by
 * every room to render text nobody here writes.
 *
 * The consequence, stated plainly: CJK characters typed onto a board still
 * appear, in whatever face the browser falls back to, without the handwriting
 * look. Delete this list to get it back.
 */
const SKIPPED_FONT_DIRS = new Set(['Xiaolai']);

let copied = 0;
let skippedFonts = 0;
for (const name of ['fonts', 'data']) {
  const from = join(source, name);
  if (!existsSync(from)) {
    console.error(`Expected ${from} to exist. Excalidraw's asset layout may have changed again.`);
    process.exit(1);
  }
  const to = join(publicDir, name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const skipped = SKIPPED_FONT_DIRS.has(basename(src)) && src !== from;
      if (skipped) skippedFonts += 1;
      return !skipped;
    },
  });
  copied += 1;
}

/*
 * Copying the fonts is not enough on its own.
 *
 * Excalidraw resolves each font to two candidates: one under
 * window.EXCALIDRAW_ASSET_PATH, and one under a hardcoded CDN base. We set the
 * variable and ship the fonts — the documented recipe — and every request still
 * went to the CDN and none to us, which is excalidraw/excalidraw#8228, open and
 * unfixed. So the fallback is rewritten to this page's own origin here.
 */
let patchedFiles = 0;
let alreadyPatched = 0;
for (const name of readdirSync(source)) {
  if (!name.endsWith('.js')) continue;
  const file = join(source, name);
  const contents = readFileSync(file, 'utf8');
  if (!contents.includes('ASSETS_FALLBACK_URL')) continue;
  if (isPatched(contents)) {
    alreadyPatched += 1;
    continue;
  }
  const { source: next, replaced } = patchAssetsFallback(contents);
  if (replaced === 0) {
    console.error(
      `Found ASSETS_FALLBACK_URL in ${file} but could not rewrite it. Excalidraw's `
      + 'bundle has changed shape: fonts would silently load from its CDN again and '
      + 'be refused by font-src. Update scripts/lib/excalidrawFontFallback.mjs.',
    );
    process.exit(1);
  }
  writeFileSync(file, next);
  patchedFiles += 1;
}

if (patchedFiles === 0 && alreadyPatched === 0) {
  console.error(
    "No ASSETS_FALLBACK_URL found in Excalidraw's bundle. Either the fonts no longer "
    + 'fall back to a CDN, or the constant was renamed. Verify in a browser that no font '
    + 'request leaves the origin before removing this check.',
  );
  process.exit(1);
}

console.log(
  `Copied ${copied} Excalidraw asset directories into public/`
  + `${skippedFonts > 0 ? `, skipping ${[...SKIPPED_FONT_DIRS].join(', ')}` : ''}. `
  + `Font fallback: ${patchedFiles} file(s) rewritten to the local origin`
  + `${alreadyPatched > 0 ? `, ${alreadyPatched} already done` : ''}.`,
);

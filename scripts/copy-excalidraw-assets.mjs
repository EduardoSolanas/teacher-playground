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
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod');
const publicDir = join(root, 'public');

if (!existsSync(source)) {
  console.error(`Excalidraw assets not found at ${source}. Run npm install first.`);
  process.exit(1);
}

let copied = 0;
for (const name of ['fonts', 'data']) {
  const from = join(source, name);
  if (!existsSync(from)) {
    console.error(`Expected ${from} to exist. Excalidraw's asset layout may have changed again.`);
    process.exit(1);
  }
  const to = join(publicDir, name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  copied += 1;
}

console.log(`Copied ${copied} Excalidraw asset directories into public/.`);

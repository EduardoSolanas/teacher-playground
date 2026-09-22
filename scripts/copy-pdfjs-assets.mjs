#!/usr/bin/env node
/**
 * Copy PDF.js's runtime data into public/pdfjs before a build
 * (spec/PDF_IMPORT_SPEC.md §4).
 *
 * PDF.js fetches these while rendering rather than bundling them: the 14
 * standard fonts a PDF may name without embedding, the CMaps that map CJK text
 * to glyphs, and the wasm image decoders (JPEG 2000, JBIG2) with their
 * JavaScript fallbacks. src/components/whiteboard/pdfRenderer.ts points PDF.js
 * at /pdfjs/, so they are served from this origin and no CSP directive has to
 * admit a CDN.
 *
 * Copied at build time rather than committed for the same reason as
 * Excalidraw's assets: the files belong to the pinned pdfjs-dist version and a
 * vendored copy would silently go stale on upgrade.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules/pdfjs-dist');
const target = join(root, 'public/pdfjs');
const DIRECTORIES = ['standard_fonts', 'cmaps', 'wasm'];

if (!existsSync(source)) {
  console.error(`pdfjs-dist not found at ${source}. Run npm install first.`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of DIRECTORIES) {
  const from = join(source, name);
  if (!existsSync(from)) {
    console.error(`Expected ${from} to exist. The pdfjs-dist layout may have changed.`);
    process.exit(1);
  }
  cpSync(from, join(target, name), { recursive: true });
}
console.log(`Copied PDF.js ${DIRECTORIES.join(', ')} into public/pdfjs.`);

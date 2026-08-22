import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { patchAssetsFallback, isPatched, LOCAL_FALLBACK } from './excalidrawFontFallback.mjs';

const REAL_CHUNK = 'node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js';

const SAMPLE = 'P(jn,"ASSETS_FALLBACK_URL",`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`);';

describe('patchAssetsFallback', () => {
  it('replaces the CDN base with this origin', () => {
    const { source, replaced } = patchAssetsFallback(SAMPLE);

    expect(replaced).toBe(1);
    expect(source).not.toContain('esm.sh');
    expect(source).toContain(`"ASSETS_FALLBACK_URL",${LOCAL_FALLBACK}`);
  });

  it('survives the nested template inside the CDN string', () => {
    // The literal contains its own backticks and ${} — a lazy match would stop
    // at the first inner backtick and leave a syntactically broken file.
    const { source } = patchAssetsFallback(SAMPLE);

    expect(source).toBe(`P(jn,"ASSETS_FALLBACK_URL",${LOCAL_FALLBACK});`);
  });

  it('is idempotent, so a rebuild does not corrupt an already patched file', () => {
    const once = patchAssetsFallback(SAMPLE).source;
    const twice = patchAssetsFallback(once);

    expect(twice.source).toBe(once);
    expect(twice.alreadyPatched).toBe(true);
    expect(isPatched(once)).toBe(true);
  });

  it('reports zero replacements when the pattern is absent', () => {
    // The caller fails the build on this. A silent no-op would put every font
    // back on the CDN, which no test would notice and no user would report
    // beyond a console full of violations.
    const { replaced } = patchAssetsFallback('const a = 1;');

    expect(replaced).toBe(0);
  });

  it('leaves unrelated esm.sh mentions alone', () => {
    const other = 'const doc = "see https://esm.sh/docs";';

    expect(patchAssetsFallback(other).source).toBe(other);
  });

  it('leaves the installed Excalidraw build pointing at this origin', () => {
    /*
     * Pins the assumption to the real dependency: if an upgrade renames the
     * constant or restructures the assignment, this fails here rather than
     * silently shipping the CDN again.
     *
     * Asserted as an outcome, not as a count of replacements: prebuild patches
     * node_modules in place, so whether this file arrives already patched
     * depends on whether a build has run. The invariant that matters is the
     * same either way — afterwards nothing points at the CDN.
     */
    const source = readFileSync(REAL_CHUNK, 'utf8');
    const { source: patched } = patchAssetsFallback(source);

    expect(patched).toContain(LOCAL_FALLBACK);
    expect(patched).not.toContain('esm.sh');
  });
});

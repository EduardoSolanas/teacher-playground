import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/*
 * PERF-S1: the LiveKit SDK (~1.8 MB with @livekit/components-react) may not
 * be part of what a browser downloads when it merely opens a room. The room
 * page's *static* import closure -- what the entry chunk must contain -- is
 * walked from RoomClient.tsx the same way a bundler would: `import` and
 * `export ... from` statements only, `import type` erased, dynamic
 * `import()` not followed. No module in that closure may pull livekit-client
 * or @livekit/components-react; the call surface is reached only through the
 * dynamic boundaries (next/dynamic for the panel, awaited import() for the
 * provider), which land in their own chunks.
 *
 * Reading the graph rather than single files keeps the boundary honest: a
 * future import that quietly re-links the SDK into the entry chunk fails
 * here with the file that broke it.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ENTRY = path.join(import.meta.dirname, 'RoomClient.tsx');

const LIVEKIT_SPECIFIERS = ['livekit-client', '@livekit/components-react'];
/*
 * PERF-S2: the PDF importer opens from a footer button, so its dialog (and the
 * pdf.js renderer it mounts) may load on first use, not with the room. The
 * walk must never reach PdfImportDialog.tsx or the pdfjs-dist package through
 * static imports; next/dynamic is the only boundary that keeps them out of the
 * entry graph.
 */
const PDF_ENTRY_SPECIFIERS = ['pdfjs-dist', 'jspdf'];
/*
 * pdfExporter.ts is the same story on the way out: it pulls Excalidraw's own
 * exportToCanvas and jsPDF, so only the editor (already behind next/dynamic)
 * may reach it. The room keeps the failure wording, which lives in the pure
 * lib module and costs nothing.
 */
const PDF_ENTRY_FILES = ['PdfImportDialog.tsx', 'pdfExporter.ts'];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
}

/** Static module specifiers of one source file; type-only imports erased. */
function staticImports(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const specifiers = new Set<string>();
  const clauseRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?[\s\S]*?\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(clauseRe)) {
    if (match[2]) continue; // import type / export type: erased at compile.
    specifiers.add(match[3]);
  }
  const bareRe = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(bareRe)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveFile(base: string): string | null {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(specifier: string, fromDir: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolveFile(path.join(SRC_ROOT, specifier.slice(2)));
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveFile(path.resolve(fromDir, specifier));
  }
  return null; // Bare package: outside src/, terminal for this walk.
}

describe('RoomClient static import graph', () => {
  /**
   * The entry's static closure: every file reachable through value imports,
   * plus every bare-package specifier those files import. Test files are not
   * followed. Type-only imports are erased, dynamic `import()` not followed.
   */
  function staticClosure(): { files: string[]; bareSpecifiers: Map<string, string[]> } {
    const visited = new Set<string>();
    const bareSpecifiers = new Map<string, string[]>();
    const queue = [ENTRY];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      if (/(?:^|[\\/])[^\\/]*\.test\.(?:ts|tsx)$/.test(file)) continue;

      const fromDir = path.dirname(file);
      const bare: string[] = [];
      for (const specifier of staticImports(file)) {
        const resolved = resolveSpecifier(specifier, fromDir);
        if (resolved === null) {
          bare.push(specifier);
          continue;
        }
        queue.push(resolved);
      }
      if (bare.length > 0) bareSpecifiers.set(path.relative(SRC_ROOT, file), bare);
    }

    return { files: [...visited], bareSpecifiers };
  }

  it('keeps livekit-client and @livekit/components-react out of the room entry chunk', () => {
    const offenders: { file: string; specifiers: string[] }[] = [];
    const { files, bareSpecifiers } = staticClosure();

    for (const [file, specifiers] of bareSpecifiers) {
      const livekit = specifiers.filter((spec) => LIVEKIT_SPECIFIERS.includes(spec));
      if (livekit.length > 0) offenders.push({ file, specifiers: livekit });
    }
    expect(files.length).toBeGreaterThan(1); // the walk itself must not go stale
    expect(offenders).toEqual([]);
  });

  it('keeps the PDF import and export code out of the room entry chunk (PERF-S2)', () => {
    const { files, bareSpecifiers } = staticClosure();

    const pdfFiles = files
      .map((file) => path.relative(SRC_ROOT, file))
      .filter((file) => PDF_ENTRY_FILES.some((name) => file.endsWith(name)));

    const pdfSpecifiers: { file: string; specifiers: string[] }[] = [];
    for (const [file, specifiers] of bareSpecifiers) {
      const pdf = specifiers.filter((spec) => PDF_ENTRY_SPECIFIERS.includes(spec));
      if (pdf.length > 0) pdfSpecifiers.push({ file, specifiers: pdf });
    }

    expect(pdfFiles).toEqual([]);
    expect(pdfSpecifiers).toEqual([]);
  });
});

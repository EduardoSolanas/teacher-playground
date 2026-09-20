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
  it('keeps livekit-client and @livekit/components-react out of the room entry chunk', () => {
    const offenders: { file: string; specifiers: string[] }[] = [];
    const visited = new Set<string>();
    const queue = [ENTRY];

    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      if (/(?:^|[\\/])[^\\/]*\.test\.(?:ts|tsx)$/.test(file)) continue;

      const fromDir = path.dirname(file);
      for (const specifier of staticImports(file)) {
        const resolved = resolveSpecifier(specifier, fromDir);
        if (resolved === null) continue;
        const source = readFileSync(resolved, 'utf8');
        const livekit = staticImports(resolved).filter((spec) =>
          LIVEKIT_SPECIFIERS.includes(spec),
        );
        if (livekit.length > 0) {
          offenders.push({ file: path.relative(SRC_ROOT, resolved), specifiers: livekit });
        }
        queue.push(resolved);
      }
    }

    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const lockfile = readFileSync(join(root, 'package-lock.json'), 'utf8');
const assetCopyScript = readFileSync(join(root, 'scripts/copy-excalidraw-assets.mjs'), 'utf8');
const packageImportFiles = [
  'next.config.js',
  'src/components/whiteboard/ExcalidrawWrapper.tsx',
  'src/lib/whiteboard/collaborators.ts',
  'src/lib/whiteboard/excalidrawReconcile.ts',
];

describe('Teacher Playground Excalidraw package', () => {
  it('uses the immutable Teacher Playground release and its package asset path', () => {
    expect(packageJson.dependencies?.['@teacher-playground/excalidraw']).toBe(
      'https://github.com/EduardoSolanas/excalidraw/releases/download/teacher-playground-v0.18.1-tp.5/package.tgz',
    );
    expect(packageJson.dependencies?.['@excalidraw/excalidraw']).toBeUndefined();
    expect(lockfile).toContain(
      'https://github.com/EduardoSolanas/excalidraw/releases/download/teacher-playground-v0.18.1-tp.5/package.tgz',
    );
    expect(assetCopyScript).toContain('node_modules/@teacher-playground/excalidraw/dist/prod');
    expect(assetCopyScript).not.toContain('node_modules/@excalidraw/excalidraw/dist/prod');
    for (const file of packageImportFiles) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).toContain('@teacher-playground/excalidraw');
      expect(source, file).not.toContain('@excalidraw/excalidraw');
    }
  });
});

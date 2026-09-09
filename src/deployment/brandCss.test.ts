import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const brandCssPath = 'public/brand.css';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('public/brand.css contract', () => {
  it('.room-shell uses dynamic viewport height (dvh) as the primary height and retains 100vh fallback for older browsers', () => {
    const css = readRepositoryFile(brandCssPath);

    // Extract the .room-shell rule
    const roomShellMatch = css.match(/\.room-shell\{[^}]*\}/);
    expect(roomShellMatch).toBeTruthy();

    const roomShellRule = roomShellMatch![0];

    // Assert that height:100vh; comes first (as fallback)
    expect(roomShellRule).toMatch(/height:100vh;/);

    // Assert that height:100dvh; comes after (to override in supporting browsers)
    expect(roomShellRule).toMatch(/height:100dvh;/);

    // Assert the correct order: 100vh before 100dvh
    const vhIndex = roomShellRule.indexOf('height:100vh;');
    const dvhIndex = roomShellRule.indexOf('height:100dvh;');
    expect(vhIndex).toBeLessThan(dvhIndex);
  });
});

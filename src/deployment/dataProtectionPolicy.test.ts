import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const docPath = 'SECURITY_DATA_PROTECTION.md';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('SECURITY_DATA_PROTECTION.md contract', () => {
  it('exists at the repository root', () => {
    expect(existsSync(resolve(repositoryRoot, docPath))).toBe(true);
  });

  it('records SEC-016 headings for lawful basis, minors, audit, and erasure', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toMatch(/^## Lawful basis and data inventory/m);
    expect(doc).toMatch(/^## Minors policy/m);
    expect(doc).toMatch(/^## Audit trail and erasure/m);
    expect(doc).toMatch(/pseudonym/i);
    expect(doc).toMatch(/erasure/i);
    expect(doc).toMatch(/authorization_audit/);
    expect(doc).toMatch(/no third-party analytics/i);
  });
});

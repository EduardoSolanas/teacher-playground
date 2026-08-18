import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const docPath = 'SECURITY_BACKUP_RESTORE.md';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('SECURITY_BACKUP_RESTORE.md contract', () => {
  it('exists at the repository root', () => {
    expect(existsSync(resolve(repositoryRoot, docPath))).toBe(true);
  });

  it('documents SQLite DO PITR, RPO, both DO classes, and staging restore drill', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toMatch(/PITR|point-in-time recovery/i);
    expect(doc).toMatch(/30[- ]day/i);
    expect(doc).toMatch(/Workers Free/i);
    expect(doc).toMatch(/\bRPO\b/i);
    expect(doc).toContain('RoomDO');
    expect(doc).toContain('IdentityDO');
    expect(doc).toMatch(/staging drill|staging restore drill/i);
    expect(doc).toMatch(/developers\.cloudflare\.com/);
  });
});

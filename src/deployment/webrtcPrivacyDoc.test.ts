import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const docPath = 'SECURITY_WEBRTC_PRIVACY.md';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('SECURITY_WEBRTC_PRIVACY.md contract', () => {
  it('exists at the repository root', () => {
    expect(existsSync(resolve(repositoryRoot, docPath))).toBe(true);
  });

  it('documents y-websocket board sync over Worker /signaling, not y-webrtc P2P', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toMatch(/y-websocket/i);
    expect(doc).toMatch(/\/signaling/);
    expect(doc).toMatch(/not.*y-webrtc|does not.*y-webrtc|no P2P WebRTC/i);
    expect(doc).not.toMatch(/board sync uses y-webrtc/i);
  });

  it('states relay-only ICE and that TURN credentials are not shipped locally', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toMatch(/relay-only/i);
    expect(doc).toMatch(/TURN/i);
    expect(doc).toMatch(/does not ship TURN credentials|not ship TURN credentials/i);
  });

  it('warns that LiveKit A/V may still expose ICE or host candidates', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toMatch(/LiveKit/i);
    expect(doc).toMatch(/ICE/i);
    expect(doc).toMatch(/host/i);
  });

  it('points to the LiveKit token modules under src/lib/av', () => {
    const doc = readRepositoryFile(docPath);

    expect(doc).toContain('src/lib/av/livekitToken.ts');
    expect(doc).toContain('src/lib/av/handleAvToken.ts');
  });
});

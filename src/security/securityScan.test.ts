import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const scannerPath = join(repositoryRoot, 'scripts', 'security-scan.mjs');
const temporaryRepositories: string[] = [];

function createRepository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'teacher-security-scan-'));
  temporaryRepositories.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(root, relativePath), content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function scan(root: string) {
  return spawnSync(process.execPath, [scannerPath, '--root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('tracked-tree security scan', () => {
  it('accepts example environment files and reserved email domains', () => {
    const root = createRepository({
      '.env.local.example': 'CONTACT=teacher@example.com\n',
      'notes.txt':
        'Tests use helper@school.test, nobody@example.org, and docs@whiteboard.example.com.\n',
    });

    const result = scan(root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Security scan passed');
  });

  it('reports forbidden categories and paths without revealing matched values', () => {
    const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const credential = `ghp_${'A'.repeat(36)}`;
    const personalEmail = ['person', 'real-school.co.uk'].join('@');
    const root = createRepository({
      '.env.production': 'SIGNALING_URL=ws://localhost:3001\n',
      'state.sqlite': 'SQLite format 3',
      'credentials.txt': `${privateKeyMarker}\n${credential}\n${personalEmail}\n`,
    });

    const result = scan(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('non-example environment file: .env.production');
    expect(output).toContain('tracked database file: state.sqlite');
    expect(output).toContain('private key material: credentials.txt');
    expect(output).toContain('known credential token: credentials.txt');
    expect(output).toContain('non-reserved email address: credentials.txt');
    expect(output).not.toContain(privateKeyMarker);
    expect(output).not.toContain(credential);
    expect(output).not.toContain(personalEmail);
  });

  it('detects Cloudflare and OpenAI credential assignments', () => {
    const cloudflareToken = 'c'.repeat(40);
    const openAiToken = `sk-proj-${'Z'.repeat(40)}`;
    const root = createRepository({
      'cloudflare.txt': `CLOUDFLARE_API_TOKEN=${cloudflareToken}\n`,
      'openai.txt': `OPENAI_API_KEY=${openAiToken}\n`,
    });

    const result = scan(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('known credential token: cloudflare.txt');
    expect(output).toContain('known credential token: openai.txt');
    expect(output).not.toContain(cloudflareToken);
    expect(output).not.toContain(openAiToken);
  });

  it('does not embed ws:// literals in production LiveKit and signaling modules', () => {
    const productionModules = [
      'src/lib/av/livekitRoomService.ts',
      'src/lib/whiteboard/yWebsocketProvider.ts',
      'src/lib/whiteboard/ywebrtcProvider.ts',
    ];

    for (const relativePath of productionModules) {
      const source = readFileSync(join(repositoryRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/ws:\/\//);
    }
  });

  it('does not skip forbidden content when a tracked file contains NUL bytes', () => {
    const privateKeyMarker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const credential = `github_pat_${'Q'.repeat(60)}`;
    const personalEmail = ['binary-owner', 'real-school.co.uk'].join('@');
    const root = createRepository({
      'binary.dat': `prefix\0${privateKeyMarker}\n${credential}\n${personalEmail}\n`,
    });

    const result = scan(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('private key material: binary.dat');
    expect(output).toContain('known credential token: binary.dat');
    expect(output).toContain('non-reserved email address: binary.dat');
    expect(output).not.toContain(privateKeyMarker);
    expect(output).not.toContain(credential);
    expect(output).not.toContain(personalEmail);
  });

  it('detects provider-prefixed and named social-login secrets', () => {
    const fineGrainedPat = `github_pat_${'R'.repeat(60)}`;
    const googleOAuthSecret = `GOCSPX-${'S'.repeat(28)}`;
    const googleAssignedSecret = 'g'.repeat(32);
    const facebookAssignedSecret = 'f'.repeat(32);
    const cloudflareAssignedSecret = 'c'.repeat(40);
    const root = createRepository({
      'github.txt': fineGrainedPat,
      'google-prefix.txt': googleOAuthSecret,
      'google-assignment.txt': `GOOGLE_CLIENT_SECRET=${googleAssignedSecret}\n`,
      'facebook-assignment.txt': `FACEBOOK_APP_SECRET=${facebookAssignedSecret}\n`,
      'cloudflare-assignment.txt': `CLOUDFLARE_ACCESS_CLIENT_SECRET=${cloudflareAssignedSecret}\n`,
    });

    const result = scan(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    for (const relativePath of [
      'github.txt',
      'google-prefix.txt',
      'google-assignment.txt',
      'facebook-assignment.txt',
      'cloudflare-assignment.txt',
    ]) {
      expect(output).toContain(`known credential token: ${relativePath}`);
    }
    for (const value of [
      fineGrainedPat,
      googleOAuthSecret,
      googleAssignedSecret,
      facebookAssignedSecret,
      cloudflareAssignedSecret,
    ]) {
      expect(output).not.toContain(value);
    }
  });
});

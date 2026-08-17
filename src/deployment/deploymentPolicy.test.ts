import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd());

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function trackedRepositoryFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function isEnvironmentFile(relativePath: string): boolean {
  const fileName = relativePath.split('/').at(-1) ?? '';
  return /^\.env(?:\.|$)/.test(fileName);
}

function isNonExampleEnvironmentFile(relativePath: string): boolean {
  const fileName = relativePath.split('/').at(-1) ?? '';
  return isEnvironmentFile(relativePath) && !fileName.endsWith('.example');
}

describe('production deployment policy', () => {
  it('runs the cryptographic Worker boundary before serving static assets', () => {
    for (const configPath of ['wrangler.toml', 'wrangler.local.toml']) {
      const config = readRepositoryFile(configPath);
      expect(config, configPath).toMatch(
        /^\[assets\]\s*\n(?:(?!^\[)[\s\S])*?^run_worker_first\s*=\s*true\s*$/m,
      );
    }
  });

  it('disables Cloudflare-generated deployment hostnames', () => {
    const wranglerConfig = readRepositoryFile('wrangler.toml');
    const topLevelConfig = wranglerConfig.split(/^\s*\[/m, 1)[0];

    expect(topLevelConfig).toMatch(/^workers_dev\s*=\s*false\s*$/m);
    expect(topLevelConfig).toMatch(/^preview_urls\s*=\s*false\s*$/m);
    expect(wranglerConfig).not.toMatch(/^\s*(?:workers_dev|preview_urls)\s*=\s*true\s*$/m);
  });

  it('keeps local context omission confined to the dedicated local config', () => {
    const production = readRepositoryFile('wrangler.toml');
    const local = readRepositoryFile('wrangler.local.toml');
    expect(production).not.toMatch(/^\s*ENVIRONMENT\s*=\s*["']local-test["']\s*$/m);
    expect(production).not.toContain('127.0.0.1');
    expect(local).toMatch(/^\s*ENVIRONMENT\s*=\s*["']local-test["']\s*$/m);
    expect(local).toContain('ACCESS_JWKS_URL');
    expect(local).toContain('ACCESS_ISSUER');
    expect(local).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY/);
  });

  it('has one authoritative Cloudflare Worker and Durable Objects deployment', () => {
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.scripts?.start).toBeUndefined();
    expect(packageJson.scripts?.['dev:signaling']).toBeUndefined();
    expect(packageJson.scripts?.dev).toBe('npm run dev:worker');
    expect(packageJson.scripts?.['security:scan']).toBe('node scripts/security-scan.mjs');
    expect(Object.values(packageJson.scripts ?? {}).join('\n')).not.toContain('server.js');
    expect(Object.values(packageJson.scripts ?? {}).join('\n')).not.toContain('signaling-server.mjs');
    expect(packageJson.devDependencies?.concurrently).toBeUndefined();

    for (const legacyPath of ['server.js', 'Dockerfile', '.dockerignore', '.github/workflows/deploy.yml']) {
      expect(existsSync(resolve(repositoryRoot, legacyPath)), legacyPath).toBe(false);
    }

    expect(existsSync(resolve(repositoryRoot, '.github/workflows/deploy-cloudflare.yml'))).toBe(true);
    const deploymentWorkflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    expect(deploymentWorkflow).toContain('npm run security:scan');
    expect(deploymentWorkflow).not.toContain('npm run security:scan || true');
    expect(deploymentWorkflow).toContain('wrangler-action');
    expect(deploymentWorkflow).not.toContain('wrangler.local.toml');
    expect(Object.values(packageJson.scripts ?? {}).join('\n')).not.toContain('wrangler.local.toml');

    const deploymentGuide = readRepositoryFile('DEPLOY.md');
    expect(deploymentGuide).toMatch(/Cloudflare Worker \+ Durable Objects is the only supported production\s+deployment/);
    expect(deploymentGuide).toContain('`npm run dev` invokes `npm run dev:worker`');
    expect(deploymentGuide).not.toContain('`npm run dev` still runs `next dev`');
    expect(deploymentGuide).not.toContain('standalone signaling server');
    expect(deploymentGuide).toContain('signaling-server.mjs');
    expect(deploymentGuide).toContain('The unreferenced `signaling-server.mjs` file');
    expect(deploymentGuide).toContain('is not a supported runtime');
  });

  it('does not track runtime environment configuration', () => {
    const trackedEnvironmentFiles = trackedRepositoryFiles().filter(isEnvironmentFile);
    const trackedRuntimeEnvironmentFiles = trackedEnvironmentFiles.filter(isNonExampleEnvironmentFile);
    const trackedSignalingReferences = trackedEnvironmentFiles.filter((relativePath) =>
      readRepositoryFile(relativePath).includes('signaling-server.mjs'),
    );

    expect(trackedRuntimeEnvironmentFiles).toEqual([]);
    expect(trackedSignalingReferences).toEqual([]);
  });
});

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

    // workers_dev is temporarily true until a custom domain is configured;
    // preview_urls must always stay false.
    expect(topLevelConfig).toMatch(/^workers_dev\s*=\s*(?:true|false)\s*/m);
    expect(topLevelConfig).toMatch(/^preview_urls\s*=\s*false\s*$/m);
    expect(wranglerConfig).not.toMatch(/^\s*preview_urls\s*=\s*true\s*$/m);
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

    for (const legacyPath of [
      'server.js',
      'signaling-server.mjs',
      'Dockerfile',
      '.dockerignore',
      '.github/workflows/deploy.yml',
    ]) {
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
    expect(deploymentGuide).toContain('The legacy Node `signaling-server.mjs` was removed');
    expect(deploymentGuide).toContain('Cloudflare Worker `/signaling` is the only signaling path');
  });

  it('pins GitHub Actions to full commit SHAs on a maintained Node LTS', () => {
    const workflowPaths = ['.github/workflows/ci.yml', '.github/workflows/deploy-cloudflare.yml'];

    for (const workflowPath of workflowPaths) {
      const workflow = readRepositoryFile(workflowPath);
      const actionRefs = [...workflow.matchAll(/^\s+uses:\s+(\S+)/gm)].map((match) => match[1]);

      expect(actionRefs.length, workflowPath).toBeGreaterThan(0);

      for (const actionRef of actionRefs) {
        expect(actionRef, `${workflowPath} ${actionRef}`).toMatch(/@[0-9a-f]{40}$/);
        expect(actionRef, `${workflowPath} ${actionRef}`).not.toMatch(/@v\d/);
      }

      expect(workflow, workflowPath).not.toMatch(/^\s+node-version:\s*['"]?20(?:\.\d+)*['"]?\s*$/m);
      expect(workflow, workflowPath).toMatch(/^\s+node-version:\s*['"]?22(?:\.\d+){2}['"]?\s*$/m);
    }
  });

  it('ignores ad-hoc test output paths', () => {
    const adHocTestOutputPaths = [
      'test-results.txt',
      'e2e-results.txt',
      'test-output.txt',
      'playwright-report/',
      'test-results/',
    ];

    for (const relativePath of adHocTestOutputPaths) {
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', '--', relativePath], {
          cwd: repositoryRoot,
          stdio: 'ignore',
        });
        ignored = true;
      } catch {
        ignored = false;
      }

      expect(ignored, relativePath).toBe(true);
    }
  });

  it('runs a blocking secret and PII scan in CI', () => {
    const ciWorkflow = readRepositoryFile('.github/workflows/ci.yml');
    expect(ciWorkflow).toContain('npm run security:scan');
    expect(ciWorkflow).not.toContain('npm run security:scan || true');
  });

  it('caps CI Playwright workers so the singleton IdentityDO is not queued past session bootstrap', () => {
    const playwrightConfig = readRepositoryFile('playwright.config.ts');
    expect(playwrightConfig).toMatch(/workers:\s*process\.env\.CI\s*\?\s*1\s*:/);
  });

  it('runs Durable Object worker tests in CI without continue-on-error', () => {
    const ciWorkflow = readRepositoryFile('.github/workflows/ci.yml');
    expect(ciWorkflow).toMatch(/^\s+run:\s+npm run test:workers\s*$/m);
    const workersStep = ciWorkflow.split(/\r?\n/).findIndex((line) =>
      /^\s+run:\s+npm run test:workers\s*$/.test(line),
    );
    expect(workersStep).toBeGreaterThan(0);
    const preceding = ciWorkflow.split(/\r?\n/).slice(Math.max(0, workersStep - 6), workersStep).join('\n');
    expect(preceding).not.toMatch(/continue-on-error:\s*true/);

    const deployWorkflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    expect(deployWorkflow).toMatch(/^\s+run:\s+npm run test:workers\s*$/m);
    const deployWorkers = deployWorkflow.split(/\r?\n/).findIndex((line) =>
      /^\s+run:\s+npm run test:workers\s*$/.test(line),
    );
    const deployPreceding = deployWorkflow.split(/\r?\n/).slice(Math.max(0, deployWorkers - 6), deployWorkers).join('\n');
    expect(deployPreceding).not.toMatch(/continue-on-error:\s*true/);
    expect(ciWorkflow).toContain('npm ci --omit=dev --ignore-scripts');
    expect(ciWorkflow).toContain('npm audit --omit=dev --audit-level=high');
  });

  it('installs CI and deploy dependencies with ignore-scripts or an explicit lifecycle allowlist', () => {
    const workflowPaths = [
      '.github/workflows/ci.yml',
      '.github/workflows/deploy-cloudflare.yml',
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = readRepositoryFile(workflowPath);
      const npmCiCommands = workflow
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('run: npm ci'));

      expect(npmCiCommands.length, workflowPath).toBeGreaterThan(0);
      for (const command of npmCiCommands) {
        expect(
          command === 'run: npm ci --ignore-scripts'
            || command === 'run: npm ci --omit=dev --ignore-scripts',
          `${workflowPath}: ${command}`,
        ).toBe(true);
      }

      const runsNativeTests =
        /^\s+run:\s+npm test\s*$/m.test(workflow) ||
        /^\s+run:\s+npm run test:workers\s*$/m.test(workflow);

      if (runsNativeTests) {
        expect(workflow, workflowPath).toMatch(/Allowlist:\s+better-sqlite3/i);
        expect(workflow, workflowPath).toMatch(/^\s+run:\s+npm rebuild better-sqlite3\s*$/m);
      }
    }
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

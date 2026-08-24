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
  /**
   * Paths that may bypass the Worker. Content-hashed, immutable, and carrying
   * no security decision — no Access check, no session, no host routing, no CSP
   * nonce. Anything else reaching the browser without the Worker running first
   * would skip the boundary this test exists to protect.
   */
  const BYPASSABLE_ASSET_PREFIXES = ['/_next/static/*', '/fonts/*', '/data/*'];

  it('runs the cryptographic Worker boundary before serving static assets', () => {
    for (const configPath of ['wrangler.toml', 'wrangler.local.toml']) {
      const config = readRepositoryFile(configPath);
      const assetsBlock = /^\[assets\]\s*\n((?:(?!^\[)[\s\S])*)/m.exec(config)?.[1];
      expect(assetsBlock, `${configPath}: no [assets] block`).toBeTruthy();

      const setting = /^run_worker_first\s*=\s*(true|\[[^\]]*\])\s*$/m.exec(assetsBlock!)?.[1];
      expect(setting, `${configPath}: run_worker_first missing`).toBeTruthy();

      if (setting === 'true') continue;

      // The array form is allowed only so immutable assets can skip the Worker.
      // It must still cover everything by default, and every exclusion must be a
      // known-safe prefix — otherwise a later edit could quietly route /api/* or
      // /auth/* around Access and the session check.
      const patterns = Array.from(setting!.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
      expect(patterns, `${configPath}: must match all paths by default`).toContain('/*');

      for (const exclusion of patterns.filter((pattern) => pattern.startsWith('!'))) {
        expect(
          BYPASSABLE_ASSET_PREFIXES,
          `${configPath}: ${exclusion} may not bypass the Worker`,
        ).toContain(exclusion.slice(1));
      }
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

  it('reconciles and uploads the pinned Excalidraw release with the playground deploy', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    expect(workflow).toContain('scripts/excalidraw-cdn.mjs reconcile');
    expect(workflow).toContain('scripts/excalidraw-cdn.mjs upload');
    expect(workflow).toContain('scripts/excalidraw-cdn.mjs verify');
    expect(workflow).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('vars.CLOUDFLARE_ACCOUNT_ID');

    const workersIndex = workflow.indexOf('run: npm run test:workers');
    const reconcileIndex = workflow.indexOf('scripts/excalidraw-cdn.mjs reconcile');
    const uploadIndex = workflow.indexOf('scripts/excalidraw-cdn.mjs upload');
    const verifyIndex = workflow.indexOf('scripts/excalidraw-cdn.mjs verify');
    const deployIndex = workflow.indexOf('- name: Deploy with Wrangler');
    expect(workersIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeGreaterThan(workersIndex);
    expect(reconcileIndex).toBeGreaterThan(deployIndex);
    expect(uploadIndex).toBeGreaterThan(reconcileIndex);
    expect(verifyIndex).toBeGreaterThan(uploadIndex);

    const infraFiles = ['infra/cloudflare/excalidraw-cdn/main.tf', 'infra/cloudflare/excalidraw-cdn/versions.tf'];
    for (const file of infraFiles) expect(existsSync(resolve(repositoryRoot, file)), file).toBe(true);

    const terraform = readRepositoryFile('infra/cloudflare/excalidraw-cdn/main.tf');
    expect(terraform).toContain('filter = {');
    expect(terraform).toContain('account = { id = var.account_id }');

    const e2eRunner = readRepositoryFile('scripts/run-e2e.mjs');
    expect(e2eRunner).toContain("NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH: '/',");
  });

  it('gates Realtime provisioning and preserves the one-time app secret contract', () => {
    const workflowPath = '.github/workflows/provision-cloudflare-realtime.yml';
    const workflow = readRepositoryFile(workflowPath);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('environment: prod');
    expect(workflow).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('vars.CLOUDFLARE_ACCOUNT_ID');
    expect(workflow).toContain('scripts/cloudflare-realtime.mjs ensure');
    expect(workflow).toContain('CLOUDFLARE_REALTIME_APP_ID');
    expect(workflow).toContain('CLOUDFLARE_REALTIME_APP_SECRET');
    expect(workflow).toMatch(/if:\s*steps\.realtime\.outputs\.created\s*==\s*'true'/);
    expect(workflow).toContain('printf \'%s\' "$APP_SECRET"');
    expect(workflow).not.toContain('echo "$APP_SECRET"');

    const gateNames = [
      'npm run security:scan',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm run test:workers',
    ];
    const ensureIndex = workflow.indexOf('scripts/cloudflare-realtime.mjs ensure');
    expect(ensureIndex).toBeGreaterThan(-1);
    for (const gate of gateNames) {
      expect(workflow.indexOf(gate), gate).toBeGreaterThan(-1);
      expect(workflow.indexOf(gate), gate).toBeLessThan(ensureIndex);
    }

    const terraform = readRepositoryFile('infra/cloudflare/realtime-sfu/main.tf');
    expect(terraform).toContain('cloudflare_calls_sfu_app');
    expect(terraform).toContain('name       = "teacher-playground-voice"');
    expect(terraform).toContain('prevent_destroy = true');
    expect(readRepositoryFile('infra/cloudflare/realtime-sfu/outputs.tf')).toMatch(/sensitive\s*=\s*true/);
    expect(readRepositoryFile('infra/cloudflare/realtime-sfu/README.md')).toMatch(/R2 service\s+is\s+not enabled;\s+account activation is a prerequisite/);
    expect(readRepositoryFile('infra/cloudflare/realtime-sfu/README.md')).toMatch(/Calls SFU app read\/write permission/);
    expect(readRepositoryFile('DEPLOY.md')).toMatch(/R2 service\s+is\s+not enabled;\s+account activation is a prerequisite/);

    const secretListIndex = workflow.indexOf('wrangler secret list --config wrangler.toml --format json');
    expect(secretListIndex).toBeGreaterThan(ensureIndex);
    expect(secretListIndex).toBeGreaterThan(workflow.indexOf('wrangler secret put CLOUDFLARE_REALTIME_APP_ID'));
    expect(secretListIndex).toBeGreaterThan(workflow.indexOf('wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET'));
    expect(workflow.slice(secretListIndex)).toContain('CLOUDFLARE_REALTIME_APP_ID');
    expect(workflow.slice(secretListIndex)).toContain('CLOUDFLARE_REALTIME_APP_SECRET');
  });

  it('exposes the Realtime provisioning path from the default deploy workflow', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+target:/);
    expect(workflow).toMatch(/target:[\s\S]*default:\s*full/);
    expect(workflow).toMatch(/target:[\s\S]*options:[\s\S]*-\s*full[\s\S]*-\s*cdn[\s\S]*-\s*realtime/);
    expect(workflow).toContain("if: github.event_name == 'push' || inputs.target == 'full' || inputs.target == 'cdn'");
    const wranglerIndex = workflow.indexOf('- name: Deploy with Wrangler');
    const realtimeIndex = workflow.indexOf('provision-realtime:');
    expect(wranglerIndex).toBeGreaterThan(-1);
    expect(realtimeIndex).toBeGreaterThan(wranglerIndex);
    const wranglerStep = workflow.slice(wranglerIndex, realtimeIndex);
    expect(wranglerStep).toContain('cloudflare/wrangler-action@');
    expect(wranglerStep).toContain("if: github.event_name == 'push' || inputs.target == 'full'");
    expect(wranglerStep).not.toContain("inputs.target == 'cdn'");
    expect(workflow).toContain('provision-realtime:');
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.target == 'realtime'");
    expect(workflow).toContain('scripts/cloudflare-realtime.mjs ensure');
    expect(workflow).toContain('wrangler secret put CLOUDFLARE_REALTIME_APP_ID');
    expect(workflow).toContain('wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET');
    expect(workflow).toContain('wrangler secret list --config wrangler.toml --format json');
    expect(workflow).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('vars.CLOUDFLARE_ACCOUNT_ID');

    const ensureIndex = workflow.indexOf('scripts/cloudflare-realtime.mjs ensure');
    for (const gate of [
      'npm run security:scan',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm run test:workers',
    ]) {
      expect(workflow.indexOf(gate), gate).toBeGreaterThan(-1);
      expect(workflow.indexOf(gate), gate).toBeLessThan(ensureIndex);
    }
    expect(workflow.indexOf('wrangler secret list --config wrangler.toml --format json'))
      .toBeGreaterThan(workflow.indexOf('wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET'));
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

  it('ignores local development variable files', () => {
    const devVarsFiles = ['.dev.vars', '.dev.vars.local', '.dev.vars.override'];
    const devVarsExample = '.dev.vars.example';

    for (const relativePath of devVarsFiles) {
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

    // .dev.vars.example SHOULD be tracked
    let exampleIgnored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', devVarsExample], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      exampleIgnored = true;
    } catch {
      exampleIgnored = false;
    }

    expect(exampleIgnored, devVarsExample).toBe(false);
  });
});

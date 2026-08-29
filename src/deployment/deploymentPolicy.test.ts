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
    const workflowPaths = [
      '.github/workflows/ci.yml',
      '.github/workflows/deploy-cloudflare.yml',
      '.github/workflows/configure-livekit.yml',
    ];
    const requiredActionPins = {
      'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
      'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/dependency-review-action': 'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
      'cloudflare/wrangler-action': 'ebbaa1584979971c8614a24965b4405ff95890e0',
    };

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

      for (const [action, sha] of Object.entries(requiredActionPins)) {
        const refs = [...workflow.matchAll(new RegExp(`^\\s+uses:\\s+${action.replace('/', '\\/')}@([0-9a-f]{40})`, 'gm'))]
          .map((match) => match[1]);
        if (refs.length > 0) expect(refs, `${workflowPath} ${action}`).toEqual([sha, ...refs.slice(1).map(() => sha)]);
      }
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

  it('consumes the fork-owned immutable Excalidraw release without publishing CDN state', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    expect(workflow).not.toMatch(/scripts\/excalidraw-cdn\.mjs/);
    expect(workflow).not.toMatch(/\bcdn\b/);
    expect(existsSync(resolve(repositoryRoot, 'scripts/excalidraw-cdn.mjs'))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, 'scripts/excalidraw-cdn.test.ts'))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, 'infra/cloudflare/excalidraw-cdn'))).toBe(false);

    const deploymentGuide = readRepositoryFile('DEPLOY.md');
    expect(deploymentGuide).toContain('fork repository is the sole owner');
    expect(deploymentGuide).toContain('latest.json');
    expect(deploymentGuide).not.toMatch(/scripts\/excalidraw-cdn\.mjs/);

    const e2eRunner = readRepositoryFile('scripts/run-e2e.mjs');
    expect(e2eRunner).toContain("NEXT_PUBLIC_EXCALIDRAW_ASSET_PATH: '/',");
  });

  it('runs increment comparison in the CI browser build', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml');
    const e2eJob = workflow.slice(workflow.indexOf('\n  e2e:'));

    expect(e2eJob).toContain("NEXT_PUBLIC_WHITEBOARD_INCREMENTS: '1'");
    expect(e2eJob).toContain("NEXT_PUBLIC_WHITEBOARD_INCREMENT_COMPARE: '1'");
  });

  it('keeps the package, CDN asset path, and CSP on the same fork release', () => {
    const packageJson = readRepositoryFile('package.json');
    const lockfile = readRepositoryFile('package-lock.json');
    const assetPath = readRepositoryFile('src/lib/whiteboard/excalidrawAssetPath.ts');
    const requestGuard = readRepositoryFile('src/lib/worker/requestGuard.ts');
    const release = '0.18.1-tp.7';
    const origin = 'https://excalidraw-assets.sen-tutor.co.uk';

    expect(packageJson).toContain(`teacher-playground-v${release}/package.tgz`);
    expect(lockfile).toContain(`teacher-playground-v${release}/package.tgz`);
    expect(assetPath).toContain(`${origin}/releases/${release}/dist/prod/`);
    expect(requestGuard).toContain(`font-src 'self' data: blob: ${origin}`);
    const deploymentGuide = readRepositoryFile('DEPLOY.md');
    expect(deploymentGuide).toContain('32781207895');
    expect(deploymentGuide).toContain('32783092806');
    expect(deploymentGuide).toContain('9,445,242');
    expect(deploymentGuide).toContain('bytes');
    expect(deploymentGuide).not.toContain('Non-existent domain');
  });

  it('uses LiveKit as the only A/V provider and tracks no Cloudflare Calls provisioning', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    const deploymentGuide = readRepositoryFile('DEPLOY.md');
    const readme = readRepositoryFile('README.md');

    expect(workflow).not.toContain('provision-realtime:');
    expect(workflow).not.toContain('cloudflare-realtime.mjs');
    expect(workflow).not.toContain('CLOUDFLARE_REALTIME_APP_ID');
    expect(workflow).not.toContain('inputs.target');
    expect(workflow).toContain('- name: Deploy with Wrangler');
    for (const callsPath of [
      '.github/workflows/provision-cloudflare-realtime.yml',
      'scripts/cloudflare-realtime.mjs',
      'scripts/cloudflare-realtime.test.ts',
      'infra/cloudflare/realtime-sfu',
    ]) {
      expect(existsSync(resolve(repositoryRoot, callsPath)), callsPath).toBe(false);
    }
    expect(deploymentGuide).not.toContain('Cloudflare Realtime voice control plane');
    expect(deploymentGuide).toContain('LIVEKIT_API_SECRET');
    expect(readme).toContain('LiveKit SFU for A/V');
  });

  it('preflights required LiveKit secrets before deploying with Wrangler', () => {
    const workflow = readRepositoryFile('.github/workflows/deploy-cloudflare.yml');
    const preflight = workflow.indexOf('npx wrangler secret list --config wrangler.toml --format json');
    const deploy = workflow.indexOf('- name: Deploy with Wrangler');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(preflight);
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
    expect(workflow).toContain("jq -r '.[].name'");
    expect(workflow).toContain('LIVEKIT_URL');
    expect(workflow).toContain('LIVEKIT_API_KEY');
    expect(workflow).toContain('LIVEKIT_API_SECRET');
    expect(workflow).toContain('Missing required LiveKit secret');
    expect(workflow).not.toMatch(/(?:echo|printf).*(?:LIVEKIT_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET)=?/);
  });

  it('keeps LiveKit secret synchronization manual, production-scoped, and non-logging', () => {
    const workflow = readRepositoryFile('.github/workflows/configure-livekit.yml');

    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/^\s+workflow_dispatch:\s*$/m);
    expect(workflow).not.toMatch(/^\s+(?:push|pull_request|schedule):/m);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents:\s+read\s*$/m);
    expect(workflow).toMatch(/^\s+environment:\s+prod\s*$/m);
    expect(workflow).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('vars.CLOUDFLARE_ACCOUNT_ID');
    expect(workflow).toContain('secrets.LIVEKIT_URL');
    expect(workflow).toContain('secrets.LIVEKIT_API_KEY');
    expect(workflow).toContain('secrets.LIVEKIT_API_SECRET');
    expect(workflow).toContain('npm ci --ignore-scripts --loglevel=error');
    expect(workflow).toContain('wrangler secret bulk --config wrangler.toml');
    expect(workflow).toContain('wrangler secret list --config wrangler.toml --format json');
    expect(workflow).not.toContain('wrangler secret put');
    expect(workflow).not.toMatch(/(?:echo|printf).*\$(?:LIVEKIT_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET)/);

    const preflight = workflow.indexOf('Missing required LiveKit secret');
    const bulk = workflow.indexOf('wrangler secret bulk --config wrangler.toml');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(bulk).toBeGreaterThan(preflight);
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
      '.github/workflows/configure-livekit.yml',
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
          command === 'run: npm ci --ignore-scripts --loglevel=error'
            || command === 'run: npm ci --omit=dev --ignore-scripts --loglevel=error',
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

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';

function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate an E2E port'));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

/**
 * Windows signals only reach the process itself, so wrangler's workerd
 * grandchild outlives the run and keeps a handle on ./out. The next build then
 * fails with EBUSY. taskkill /T ends the whole tree.
 */
function killTree(pid) {
  if (process.platform !== 'win32' || !pid) return;
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    // The parent is gone, but a detached grandchild may not be.
    killTree(child.pid);
    return;
  }
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolveExit) => {
      child.once('exit', () => resolveExit(true));
      child.once('error', () => resolveExit(true));
    }),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  if (stopped || child.exitCode !== null) {
    // Exiting cleanly does not guarantee its children did.
    killTree(child.pid);
    return;
  }
  child.kill('SIGKILL');
  killTree(child.pid);
  await Promise.race([
    new Promise((resolveExit) => {
      child.once('exit', resolveExit);
      child.once('error', resolveExit);
    }),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
}

function waitForChild(child) {
  return new Promise((resolveResult) => {
    child.once('error', () => resolveResult(1));
    child.once('exit', (code, signal) => resolveResult(signal ? 1 : (code ?? 1)));
  });
}

async function waitForIssuer(issuer, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local Access issuer exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${issuer}/health`)).ok) return;
    } catch {
      // Wait for the issuer to bind.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('local Access issuer did not start');
}

async function waitForProxy(baseURL, token, proxy, upstream) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (proxy.exitCode !== null) throw new Error(`local Access proxy exited with ${proxy.exitCode}`);
    if (upstream.exitCode !== null) throw new Error(`local Wrangler exited with ${upstream.exitCode}`);
    try {
      const response = await fetch(baseURL, { headers: { Cookie: `CF_Authorization=${token}` } });
      if (response.ok) return;
    } catch {
      // Wait for Wrangler and the proxy to bind.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('local Access proxy/workerd did not start');
}

const appPort = process.env.E2E_PORT || String(await getAvailablePort());
const baseURL = `http://localhost:${appPort}`;
const skipBuild = process.argv.includes('--skip-build') || Boolean(process.env.E2E_SKIP_BUILD);
const playwrightArgs = process.argv.slice(2).filter((argument) => argument !== '--skip-build');
const accessPort = await getAvailablePort();
const upstreamPort = await getAvailablePort();
const accessProxyPort = Number(appPort);
const accessIssuer = `http://127.0.0.1:${accessPort}`;
const accessProxy = resolve(process.cwd(), 'scripts/local-access-proxy.mjs');
const wrangler = resolve(process.cwd(), 'node_modules/wrangler/bin/wrangler.js');

let accessIssuerProcess;
let buildProcess;
let wranglerProcess;
let accessProxyProcess;
let playwrightProcess;
let result = 1;
let buildPassed = true;
let cleanupPromise;
let interrupted = false;

function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await stopChild(playwrightProcess);
      await stopChild(accessProxyProcess);
      await stopChild(wranglerProcess);
      await stopChild(buildProcess);
      await stopChild(accessIssuerProcess);
    })();
  }
  return cleanupPromise;
}

function stopOnSignal() {
  interrupted = true;
  result = 1;
  void cleanup().finally(() => {
    process.exitCode = result;
  });
}

process.once('SIGINT', stopOnSignal);
process.once('SIGTERM', stopOnSignal);

try {
  accessIssuerProcess = spawn(process.execPath, [resolve(process.cwd(), 'scripts/local-access-issuer.mjs')], {
    env: { ...process.env, LOCAL_ACCESS_PORT: String(accessPort) },
    stdio: 'inherit',
  });
  await waitForIssuer(accessIssuer, accessIssuerProcess);
  const tokenResponse = await fetch(`${accessIssuer}/token?sub=e2e-human`);
  if (!tokenResponse.ok) throw new Error(`local Access token failed: ${tokenResponse.status}`);
  const tokenPayload = await tokenResponse.json();
  if (!tokenPayload || typeof tokenPayload.token !== 'string') throw new Error('local Access issuer returned no token');
  const accessToken = tokenPayload.token;
  if (interrupted) throw new Error('E2E run interrupted');

  if (!skipBuild) {
    buildProcess = spawn(process.execPath, [resolve(process.cwd(), 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
      stdio: 'inherit',
      env: { ...process.env, NEXT_PUBLIC_E2E: '1' },
    });
    const buildCode = await waitForChild(buildProcess);
    if (buildCode !== 0) {
      buildPassed = false;
      result = buildCode;
    }
  }

  if (buildPassed) {
    if (interrupted) throw new Error('E2E run interrupted');
    wranglerProcess = spawn(process.execPath, [
      wrangler,
      'dev',
      '--config', 'wrangler.local.toml',
      '--var', 'ENVIRONMENT:local-test',
      '--var', `ACCESS_ISSUER:${accessIssuer}`,
      '--var', 'ACCESS_AUDIENCE:teacher-playground-local',
      '--var', `ACCESS_JWKS_URL:${accessIssuer}/jwks`,
      '--ip', '127.0.0.1',
      '--port', String(upstreamPort),
    ], { stdio: 'inherit' });
    accessProxyProcess = spawn(process.execPath, [accessProxy], {
      env: {
        ...process.env,
        LOCAL_ACCESS_PROXY_PORT: String(accessProxyPort),
        LOCAL_ACCESS_UPSTREAM_PORT: String(upstreamPort),
      },
      stdio: 'inherit',
    });
    await waitForProxy(baseURL, accessToken, accessProxyProcess, wranglerProcess);
    if (interrupted) throw new Error('E2E run interrupted');

    playwrightProcess = spawn(
      process.execPath,
      ['node_modules/playwright/cli.js', 'test', ...playwrightArgs],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_PORT: String(accessProxyPort),
          PLAYWRIGHT_BASE_URL: baseURL,
          E2E_ACCESS_ISSUER: accessIssuer,
          E2E_ACCESS_TOKEN: accessToken,
        },
      },
    );
    result = await waitForChild(playwrightProcess);
  }
} finally {
  process.removeListener('SIGINT', stopOnSignal);
  process.removeListener('SIGTERM', stopOnSignal);
  await cleanup();
}

process.exitCode = result;
